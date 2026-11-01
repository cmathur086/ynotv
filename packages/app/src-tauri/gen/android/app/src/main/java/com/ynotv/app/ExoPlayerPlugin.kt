package com.ynotv.app

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.view.Gravity
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.BehindLiveWindowException
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class HttpOptionsArgs {
  var userAgent: String? = null
  var referrer: String? = null
  /** mpv `http-header-fields` format: "Name: value,Other: value". */
  var headers: String? = null
}

@InvokeArg
class LoadArgs {
  var url: String = ""
}

@InvokeArg
class PausedArgs {
  var paused: Boolean = false
}

@InvokeArg
class MutedArgs {
  var muted: Boolean = false
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@InvokeArg
class VolumeArgs {
  var volume: Double = 100.0
}

@InvokeArg
class SpeedArgs {
  var speed: Double = 1.0
}

@InvokeArg
class TrackArgs {
  var type: String = ""
  var id: Long = 0
}

@InvokeArg
class CycleArgs {
  var type: String = ""
}

@InvokeArg
class SubtitleArgs {
  var url: String = ""
  var select: Boolean = true
  var title: String? = null
  var lang: String? = null
}

@InvokeArg
class SubtitleStyleArgs {
  var name: String = ""
  var value: Any? = null
}

@InvokeArg
class GeometryArgs {
  var x: Int = 0
  var y: Int = 0
  var width: Int = 0
  var height: Int = 0
}

/**
 * ExoPlayer (Media3) backend for ynoTV on Android / Android TV.
 *
 * The Rust side (mpv_core_android.rs) exposes the same commands the desktop
 * libmpv core does and calls into this plugin. Video renders into a
 * SurfaceView placed *behind* the WebView, which is made transparent, so the
 * web UI composites over the video exactly like it does over the embedded mpv
 * window on desktop.
 *
 * Every command hops onto the UI thread: ExoPlayer must be used from the
 * thread that created it, and Tauri runs plugin commands on the caller's thread.
 */
@UnstableApi
@TauriPlugin
class ExoPlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var player: ExoPlayer? = null
  private var container: FrameLayout? = null
  private var aspectFrame: AspectRatioFrameLayout? = null
  private var subtitleView: SubtitleView? = null

  private var http = HttpOptionsArgs()
  /** Rebuilt whenever the HTTP options change; every open goes through it. */
  private var sourceFactory: DefaultMediaSourceFactory? = null
  private var currentItem: MediaItem? = null
  private val externalSubtitles = mutableListOf<MediaItem.SubtitleConfiguration>()
  private var pendingSubtitleSelect: String? = null

  /** mpv-style volume (0-100+) and mute, applied together to the player. */
  private var volume = 100.0
  private var muted = false

  private var awaitingLoaded = false
  private var suppressNextLoaded = false
  private var loadedSeq = 0L
  private var errorSeq = 0L
  private var errorMessage: String? = null
  private var httpStatus: Int? = null

  // Subtitle appearance, built up from mpv sub-* properties.
  private var subColor = Color.WHITE
  private var subBackColor = Color.TRANSPARENT
  private var subBorderColor = Color.BLACK
  private var subBackgroundBox = false
  private var subFontSize = 55.0
  private var subScale = 1.0
  private var subPos = 100.0

  /** Tracks in mpv numbering: ids start at 1 per type, as in mpv's track-list. */
  private data class TrackRef(
    val type: String,
    val id: Long,
    val group: Tracks.Group,
    val index: Int,
  )

  override fun load(webView: WebView) {
    this.webView = webView
  }

  private fun onUi(invoke: Invoke, block: () -> JSObject?) {
    activity.runOnUiThread {
      try {
        val result = block()
        if (result != null) invoke.resolve(result) else invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  @Command
  fun init(invoke: Invoke) {
    val args = invoke.parseArgs(HttpOptionsArgs::class.java)
    onUi(invoke) {
      releasePlayer()
      http = args
      createPlayer()
      null
    }
  }

  @Command
  fun release(invoke: Invoke) {
    onUi(invoke) {
      releasePlayer()
      null
    }
  }

  override fun onDestroy() {
    activity.runOnUiThread { releasePlayer() }
  }

  private fun buildMediaSourceFactory(): DefaultMediaSourceFactory {
    val headers = mutableMapOf<String, String>()
    http.headers?.split(',')?.forEach { field ->
      val (name, value) = field.split(':', limit = 2).let {
        if (it.size == 2) it[0].trim() to it[1].trim() else return@forEach
      }
      if (name.isNotEmpty()) headers[name] = value
    }
    http.referrer?.takeIf { it.isNotBlank() }?.let { headers["Referer"] = it }

    val httpFactory = DefaultHttpDataSource.Factory()
      .setUserAgent(http.userAgent?.takeIf { it.isNotBlank() } ?: DEFAULT_USER_AGENT)
      // IPTV providers routinely redirect http -> https (and back) to their CDN.
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(20_000)
      .setDefaultRequestProperties(headers)

    // Raw MPEG-TS live channels often lack clean access-unit boundaries and
    // start mid-GOP; these flags let the extractor start without waiting for
    // an IDR frame.
    val extractors = DefaultExtractorsFactory().setTsExtractorFlags(
      DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS or
        DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES
    )
    return DefaultMediaSourceFactory(DefaultDataSource.Factory(activity, httpFactory), extractors)
  }

  private fun createPlayer() {
    val root = activity.findViewById<ViewGroup>(android.R.id.content)

    val frame = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
    val aspect = AspectRatioFrameLayout(activity).apply {
      resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
    }
    val surface = SurfaceView(activity)
    aspect.addView(surface, FrameLayout.LayoutParams(MATCH, MATCH))
    frame.addView(aspect, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.CENTER))
    val subs = SubtitleView(activity).apply { visibility = View.GONE }
    frame.addView(subs, FrameLayout.LayoutParams(MATCH, MATCH))
    frame.visibility = View.GONE

    // Index 0 = behind the WebView; the WebView becomes transparent so the
    // web UI composites over the video.
    root.addView(frame, 0, FrameLayout.LayoutParams(MATCH, MATCH))
    webView?.setBackgroundColor(Color.TRANSPARENT)

    val factory = buildMediaSourceFactory()
    sourceFactory = factory
    val exo = ExoPlayer.Builder(activity)
      .setMediaSourceFactory(factory)
      .build()
    exo.setVideoSurfaceView(surface)
    exo.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY && awaitingLoaded) {
          awaitingLoaded = false
          if (suppressNextLoaded) suppressNextLoaded = false else loadedSeq++
        }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        if (videoSize.width > 0 && videoSize.height > 0) {
          aspect.setAspectRatio(
            videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
          )
        }
      }

      override fun onTracksChanged(tracks: Tracks) {
        val url = pendingSubtitleSelect ?: return
        val ref = trackRefs().firstOrNull { it.type == "sub" && isExternal(it, url) } ?: return
        pendingSubtitleSelect = null
        select(ref)
      }

      override fun onPlayerError(error: PlaybackException) {
        // A live stream that fell behind its window just needs to rejoin live.
        if (error.cause is BehindLiveWindowException) {
          exo.seekToDefaultPosition()
          exo.prepare()
          return
        }
        errorSeq++
        httpStatus = findHttpStatus(error)
        errorMessage = listOfNotNull(error.errorCodeName, error.cause?.message ?: error.message)
          .joinToString(": ")
      }
    })
    exo.addListener(object : Player.Listener {
      override fun onCues(cueGroup: androidx.media3.common.text.CueGroup) {
        subs.setCues(cueGroup.cues)
      }
    })

    player = exo
    container = frame
    aspectFrame = aspect
    subtitleView = subs
    applyVolume()
    applySubtitleStyle()
  }

  private fun releasePlayer() {
    player?.release()
    player = null
    sourceFactory = null
    container?.let { (it.parent as? ViewGroup)?.removeView(it) }
    container = null
    aspectFrame = null
    subtitleView = null
    currentItem = null
    externalSubtitles.clear()
    pendingSubtitleSelect = null
    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  private fun requirePlayer(): ExoPlayer =
    player ?: throw IllegalStateException("Player not initialized")

  // ─── Playback ─────────────────────────────────────────────────────────────

  @Command
  fun load(invoke: Invoke) {
    val args = invoke.parseArgs(LoadArgs::class.java)
    onUi(invoke) {
      val exo = requirePlayer()
      externalSubtitles.clear()
      pendingSubtitleSelect = null
      errorMessage = null
      httpStatus = null

      val builder = MediaItem.Builder().setUri(Uri.parse(args.url))
      // HLS is only detected from the extension; hint it for URLs that carry
      // m3u8 elsewhere (query strings, Xtream `output=m3u8`).
      if (args.url.contains("m3u8", ignoreCase = true)) {
        builder.setMimeType(MimeTypes.APPLICATION_M3U8)
      }
      val item = builder.build()
      currentItem = item

      // mpv selects no subtitle on load here; the frontend picks one itself.
      exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
        .clearOverrides()
        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
        .build()

      awaitingLoaded = true
      suppressNextLoaded = false
      open(exo, item, null)
      exo.prepare()
      exo.playWhenReady = true
      container?.visibility = View.VISIBLE
      null
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    onUi(invoke) {
      player?.stop()
      player?.clearMediaItems()
      currentItem = null
      awaitingLoaded = false
      container?.visibility = View.GONE
      null
    }
  }

  @Command
  fun setPaused(invoke: Invoke) {
    val args = invoke.parseArgs(PausedArgs::class.java)
    onUi(invoke) {
      requirePlayer().playWhenReady = !args.paused
      null
    }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    onUi(invoke) {
      requirePlayer().seekTo((args.seconds * 1000).toLong().coerceAtLeast(0))
      null
    }
  }

  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeArgs::class.java)
    onUi(invoke) {
      volume = args.volume.coerceAtLeast(0.0)
      applyVolume()
      null
    }
  }

  @Command
  fun setMuted(invoke: Invoke) {
    val args = invoke.parseArgs(MutedArgs::class.java)
    onUi(invoke) {
      muted = args.muted
      applyVolume()
      null
    }
  }

  @Command
  fun toggleMute(invoke: Invoke) {
    onUi(invoke) {
      muted = !muted
      applyVolume()
      null
    }
  }

  @Command
  fun setSpeed(invoke: Invoke) {
    val args = invoke.parseArgs(SpeedArgs::class.java)
    onUi(invoke) {
      requirePlayer().setPlaybackSpeed(args.speed.toFloat().coerceIn(0.1f, 8f))
      null
    }
  }

  @Command
  fun setHttpOptions(invoke: Invoke) {
    val args = invoke.parseArgs(HttpOptionsArgs::class.java)
    onUi(invoke) {
      args.userAgent?.let { http.userAgent = it }
      args.referrer?.let { http.referrer = it }
      args.headers?.let { http.headers = it }
      sourceFactory = buildMediaSourceFactory()
      // Re-open the current item so the new headers apply to it too.
      val exo = player
      val item = currentItem
      if (exo != null && item != null) {
        val wasPlaying = exo.playWhenReady
        awaitingLoaded = true
        suppressNextLoaded = true
        open(exo, item, exo.currentPosition)
        exo.prepare()
        exo.playWhenReady = wasPlaying
      }
      null
    }
  }

  /** Open [item] through the current HTTP options, optionally resuming at [positionMs]. */
  private fun open(exo: ExoPlayer, item: MediaItem, positionMs: Long?) {
    val factory = sourceFactory ?: buildMediaSourceFactory().also { sourceFactory = it }
    val source = factory.createMediaSource(item)
    if (positionMs != null) exo.setMediaSource(source, positionMs) else exo.setMediaSource(source)
  }

  private fun applyVolume() {
    // ExoPlayer can't amplify past 1.0, so mpv's >100% boost tops out at 100.
    player?.volume = if (muted) 0f else (volume / 100.0).coerceIn(0.0, 1.0).toFloat()
  }

  // ─── Geometry ─────────────────────────────────────────────────────────────

  @Command
  fun setGeometry(invoke: Invoke) {
    val args = invoke.parseArgs(GeometryArgs::class.java)
    onUi(invoke) {
      container?.let { view ->
        val params = if (args.width <= 0 || args.height <= 0) {
          FrameLayout.LayoutParams(MATCH, MATCH)
        } else {
          FrameLayout.LayoutParams(args.width, args.height, Gravity.TOP or Gravity.START).apply {
            leftMargin = args.x
            topMargin = args.y
          }
        }
        view.layoutParams = params
      }
      null
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  @Command
  fun status(invoke: Invoke) {
    onUi(invoke) {
      val obj = JSObject()
      val exo = player
      if (exo == null) {
        obj.put("idle", true)
        obj.put("volume", volume)
        obj.put("muted", muted)
        return@onUi obj
      }
      val state = exo.playbackState
      val duration = exo.duration
      val live = exo.isCurrentMediaItemLive
      obj.put("playWhenReady", exo.playWhenReady)
      obj.put("isPlaying", exo.isPlaying)
      obj.put("buffering", state == Player.STATE_BUFFERING)
      obj.put("ended", state == Player.STATE_ENDED)
      obj.put("idle", state == Player.STATE_IDLE || exo.currentMediaItem == null)
      obj.put("volume", volume)
      obj.put("muted", muted)
      obj.put("position", exo.currentPosition / 1000.0)
      obj.put("duration", if (duration == C.TIME_UNSET || live) 0.0 else duration / 1000.0)
      obj.put("isLive", live)
      obj.put("bufferedPosition", exo.bufferedPosition / 1000.0)
      val videoFormat = exo.videoFormat
      obj.put("hasVideo", videoFormat != null)
      videoFormat?.let { fmt ->
        obj.put("videoFormat", codecName(fmt.sampleMimeType))
        trackRefs().firstOrNull { it.type == "video" && it.group.isTrackSelected(it.index) }
          ?.let { obj.put("videoTrackId", it.id) }
      }
      obj.put("loadedSeq", loadedSeq)
      obj.put("errorSeq", errorSeq)
      errorMessage?.let { obj.put("errorMessage", it) }
      httpStatus?.let { obj.put("httpStatus", it) }
      obj
    }
  }

  private fun findHttpStatus(error: PlaybackException): Int? {
    var cause: Throwable? = error
    while (cause != null) {
      if (cause is HttpDataSource.InvalidResponseCodeException) return cause.responseCode
      cause = cause.cause
    }
    return null
  }

  // ─── Tracks ───────────────────────────────────────────────────────────────

  private fun trackRefs(): List<TrackRef> {
    val exo = player ?: return emptyList()
    val counters = mutableMapOf<String, Long>()
    val refs = mutableListOf<TrackRef>()
    for (group in exo.currentTracks.groups) {
      val type = when (group.type) {
        C.TRACK_TYPE_VIDEO -> "video"
        C.TRACK_TYPE_AUDIO -> "audio"
        C.TRACK_TYPE_TEXT -> "sub"
        else -> continue
      }
      for (i in 0 until group.length) {
        if (!group.isTrackSupported(i)) continue
        val id = (counters[type] ?: 0L) + 1
        counters[type] = id
        refs.add(TrackRef(type, id, group, i))
      }
    }
    return refs
  }

  private fun isExternal(ref: TrackRef, url: String? = null): Boolean {
    val id = ref.group.getTrackFormat(ref.index).id ?: return false
    return externalSubtitles.any { cfg ->
      val cfgId = cfg.id ?: return@any false
      (url == null || cfgId == url) && id.contains(cfgId)
    }
  }

  private fun externalUrl(ref: TrackRef): String? {
    val id = ref.group.getTrackFormat(ref.index).id ?: return null
    return externalSubtitles.firstOrNull { cfg -> cfg.id?.let { id.contains(it) } == true }?.id
  }

  @Command
  fun tracks(invoke: Invoke) {
    onUi(invoke) {
      val list = JSArray()
      for (ref in trackRefs()) {
        val fmt = ref.group.getTrackFormat(ref.index)
        val track = JSObject()
        track.put("id", ref.id)
        track.put("type", ref.type)
        track.put("selected", ref.group.isTrackSelected(ref.index))
        fmt.language?.let { track.put("lang", it) }
        fmt.label?.let { track.put("title", it) }
        codecName(fmt.sampleMimeType ?: fmt.codecs)?.let { track.put("codec", it) }
        track.put("default", fmt.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0)
        track.put("forced", fmt.selectionFlags and C.SELECTION_FLAG_FORCED != 0)
        val external = externalUrl(ref)
        track.put("external", external != null)
        external?.let { track.put("external-filename", it) }
        if (fmt.width != Format.NO_VALUE) track.put("demux-w", fmt.width)
        if (fmt.height != Format.NO_VALUE) track.put("demux-h", fmt.height)
        if (fmt.frameRate != Format.NO_VALUE.toFloat()) track.put("demux-fps", fmt.frameRate.toDouble())
        if (fmt.channelCount != Format.NO_VALUE) track.put("demux-channel-count", fmt.channelCount)
        if (fmt.sampleRate != Format.NO_VALUE) track.put("demux-samplerate", fmt.sampleRate)
        if (fmt.bitrate != Format.NO_VALUE) track.put("demux-bitrate", fmt.bitrate)
        list.put(track)
      }
      JSObject().apply { put("tracks", list) }
    }
  }

  private fun trackType(type: String): Int = when (type) {
    "video" -> C.TRACK_TYPE_VIDEO
    "audio" -> C.TRACK_TYPE_AUDIO
    else -> C.TRACK_TYPE_TEXT
  }

  private fun select(ref: TrackRef) {
    val exo = requirePlayer()
    exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
      .setTrackTypeDisabled(trackType(ref.type), false)
      .setOverrideForType(TrackSelectionOverride(ref.group.mediaTrackGroup, ref.index))
      .build()
  }

  @Command
  fun selectTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)
    onUi(invoke) {
      val exo = requirePlayer()
      if (args.id <= 0) {
        // mpv's "no": switch the track type off.
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(trackType(args.type))
          .setTrackTypeDisabled(trackType(args.type), true)
          .build()
      } else {
        val ref = trackRefs().firstOrNull { it.type == args.type && it.id == args.id }
          ?: throw IllegalArgumentException("No ${args.type} track with id ${args.id}")
        select(ref)
      }
      null
    }
  }

  @Command
  fun cycleTrack(invoke: Invoke) {
    val args = invoke.parseArgs(CycleArgs::class.java)
    onUi(invoke) {
      val exo = requirePlayer()
      val refs = trackRefs().filter { it.type == args.type }
      val disabled = exo.trackSelectionParameters.disabledTrackTypes.contains(trackType(args.type))
      val current = if (disabled) -1 else refs.indexOfFirst { it.group.isTrackSelected(it.index) }
      val next = current + 1
      if (next < refs.size) {
        select(refs[next])
      } else if (args.type == "sub") {
        // mpv cycles subtitles through "no" after the last track.
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_TEXT)
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
          .build()
      } else if (refs.isNotEmpty()) {
        select(refs[0])
      }
      null
    }
  }

  // ─── External subtitles ───────────────────────────────────────────────────

  private fun subtitleMime(url: String): String {
    val path = url.substringBefore('?').substringBefore('#').lowercase()
    return when {
      path.endsWith(".srt") -> MimeTypes.APPLICATION_SUBRIP
      path.endsWith(".ass") || path.endsWith(".ssa") -> MimeTypes.TEXT_SSA
      path.endsWith(".ttml") || path.endsWith(".dfxp") || path.endsWith(".xml") -> MimeTypes.APPLICATION_TTML
      else -> MimeTypes.TEXT_VTT
    }
  }

  /** Side-loaded subtitles are part of the MediaItem, so re-prepare in place. */
  private fun reloadWithSubtitles() {
    val exo = requirePlayer()
    val item = currentItem ?: return
    val updated = item.buildUpon().setSubtitleConfigurations(externalSubtitles.toList()).build()
    currentItem = updated
    val position = exo.currentPosition
    val wasPlaying = exo.playWhenReady
    // Not a new file: don't announce mpv-file-loaded for the re-prepare.
    awaitingLoaded = true
    suppressNextLoaded = true
    open(exo, updated, position)
    exo.prepare()
    exo.playWhenReady = wasPlaying
  }

  @Command
  fun addSubtitle(invoke: Invoke) {
    val args = invoke.parseArgs(SubtitleArgs::class.java)
    onUi(invoke) {
      externalSubtitles.removeAll { it.id == args.url }
      val config = MediaItem.SubtitleConfiguration.Builder(Uri.parse(args.url))
        .setId(args.url)
        .setMimeType(subtitleMime(args.url))
        .setLabel(args.title)
        .setLanguage(args.lang)
        .build()
      externalSubtitles.add(config)
      pendingSubtitleSelect = if (args.select) args.url else null
      reloadWithSubtitles()
      null
    }
  }

  @Command
  fun removeSubtitle(invoke: Invoke) {
    val args = invoke.parseArgs(SubtitleArgs::class.java)
    onUi(invoke) {
      if (externalSubtitles.removeAll { it.id == args.url }) {
        reloadWithSubtitles()
      }
      null
    }
  }

  // ─── Subtitle style (mpv sub-* properties) ────────────────────────────────

  @Command
  fun setSubtitleStyle(invoke: Invoke) {
    val args = invoke.parseArgs(SubtitleStyleArgs::class.java)
    onUi(invoke) {
      val value = args.value
      when (args.name) {
        "sub-visibility" -> subtitleView?.visibility =
          if (asBool(value) != false) View.VISIBLE else View.GONE
        "sub-color" -> parseMpvColor(value)?.let { subColor = it }
        "sub-back-color" -> parseMpvColor(value)?.let { subBackColor = it }
        "sub-border-color" -> parseMpvColor(value)?.let { subBorderColor = it }
        "sub-border-style" -> subBackgroundBox = value?.toString() == "background-box"
        "sub-font-size" -> asDouble(value)?.let { subFontSize = it }
        "sub-scale" -> asDouble(value)?.let { subScale = it }
        "sub-pos" -> asDouble(value)?.let { subPos = it }
        else -> {} // sub-delay, sub-ass-*, sub-align-*: no ExoPlayer equivalent
      }
      applySubtitleStyle()
      null
    }
  }

  private fun applySubtitleStyle() {
    val view = subtitleView ?: return
    view.setStyle(
      CaptionStyleCompat(
        subColor,
        if (subBackgroundBox) subBackColor else Color.TRANSPARENT,
        Color.TRANSPARENT,
        if (subBackgroundBox) CaptionStyleCompat.EDGE_TYPE_NONE else CaptionStyleCompat.EDGE_TYPE_OUTLINE,
        subBorderColor,
        null,
      )
    )
    // mpv's sub-font-size is relative to a 720-line canvas (default 55);
    // ExoPlayer's default fractional size is 0.0533 of the view height.
    view.setFractionalTextSize((SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * subFontSize / 55.0 * subScale).toFloat())
    // sub-pos 100 = bottom edge; ExoPlayer pads from the bottom.
    view.setBottomPaddingFraction(
      (SubtitleView.DEFAULT_BOTTOM_PADDING_FRACTION + (100.0 - subPos) / 100.0).toFloat().coerceIn(0f, 0.9f)
    )
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private fun asBool(value: Any?): Boolean? = when (value) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> when (value) { "yes", "true" -> true; "no", "false" -> false; else -> null }
    else -> null
  }

  private fun asDouble(value: Any?): Double? = when (value) {
    is Number -> value.toDouble()
    is String -> value.toDoubleOrNull()
    else -> null
  }

  /** mpv colors: "#RRGGBB", "#AARRGGBB", or "r/g/b[/a]" with 0-1 or 0-255 components. */
  private fun parseMpvColor(value: Any?): Int? {
    val text = value?.toString()?.trim() ?: return null
    if (text.startsWith("#")) {
      return try { Color.parseColor(text) } catch (_: IllegalArgumentException) { null }
    }
    val parts = text.split('/').mapNotNull { it.trim().toDoubleOrNull() }
    if (parts.size < 3) return null
    val scale = if (parts.all { it <= 1.0 }) 255.0 else 1.0
    fun c(v: Double) = (v * scale).toInt().coerceIn(0, 255)
    val alpha = if (parts.size >= 4) c(parts[3]) else 255
    return Color.argb(alpha, c(parts[0]), c(parts[1]), c(parts[2]))
  }

  /** Short codec names like mpv reports ("h264", "hevc", "aac"). */
  private fun codecName(mime: String?): String? = when (mime) {
    null -> null
    MimeTypes.VIDEO_H264 -> "h264"
    MimeTypes.VIDEO_H265 -> "hevc"
    MimeTypes.VIDEO_VP9 -> "vp9"
    MimeTypes.VIDEO_AV1 -> "av1"
    MimeTypes.VIDEO_MPEG2 -> "mpeg2video"
    MimeTypes.AUDIO_AAC -> "aac"
    MimeTypes.AUDIO_AC3 -> "ac3"
    MimeTypes.AUDIO_E_AC3 -> "eac3"
    MimeTypes.AUDIO_MPEG -> "mp3"
    MimeTypes.AUDIO_OPUS -> "opus"
    MimeTypes.TEXT_VTT -> "webvtt"
    MimeTypes.APPLICATION_SUBRIP -> "subrip"
    MimeTypes.TEXT_SSA -> "ass"
    MimeTypes.APPLICATION_CEA608 -> "eia_608"
    else -> mime.substringAfter('/')
  }

  companion object {
    private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    private const val DEFAULT_USER_AGENT = "ynoTV (Linux; Android) ExoPlayer"
  }
}
