import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";

export type YouTubePlayerProps = {
  videoId: string;
  title: string;
  onError: () => void;
};

const APP_ORIGIN = "https://io.github.prajaktcs.chotu";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function playerDocument(videoId: string): string {
  // Only a validated video ID enters this document; no app/profile data or exercise title does.
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>
html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
#player { width: 100%; height: 100%; min-width: 200px; min-height: 200px; }
</style>
</head>
<body>
<div id="player"></div>
<script>
(function () {
  var player;
  function reportError() {
    window.ReactNativeWebView.postMessage('youtube-error');
  }
  window.onYouTubeIframeAPIReady = function () {
    try {
      player = new YT.Player('player', {
        width: '100%',
        height: '100%',
        videoId: ${JSON.stringify(videoId)},
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          origin: '${APP_ORIGIN}',
          autoplay: 0,
          controls: 1,
          playsinline: 1
        },
        events: {
          onReady: function (event) {
            event.target.getIframe().setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          },
          onError: reportError
        }
      });
    } catch (error) {
      reportError();
    }
  };
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && player && typeof player.pauseVideo === 'function') {
      player.pauseVideo();
    }
  });
  window.addEventListener('pagehide', function () {
    if (player && typeof player.destroy === 'function') player.destroy();
  });
  var script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = reportError;
  document.head.appendChild(script);
}());
</script>
</body>
</html>`;
}

function allowNavigation(
  request: Pick<ShouldStartLoadRequest, "url"> & { isTopFrame?: boolean },
  videoId: string,
): boolean {
  // iOS identifies child-frame navigation. Android omits this field, so it uses the
  // document/embed allowlist below; ordinary script/media subresources are not navigation.
  if (request.isTopFrame === false) return true;
  if (request.url === "about:blank") return true;
  try {
    const url = new URL(request.url);
    if (url.username || url.password) return false;
    if (url.origin === APP_ORIGIN && url.pathname === "/") return true;
    return (
      (url.origin === "https://www.youtube-nocookie.com" ||
        url.origin === "https://www.youtube.com") &&
      url.pathname === `/embed/${videoId}`
    );
  } catch {
    return false;
  }
}

export function YouTubePlayer({ videoId, title, onError }: YouTubePlayerProps): React.JSX.Element {
  const [width, setWidth] = useState(200);
  // The length check also rejects a final newline, which JavaScript's $ anchor permits.
  const valid = videoId.length === 11 && VIDEO_ID.test(videoId);
  const source = useMemo(
    () => (valid ? { html: playerDocument(videoId), baseUrl: APP_ORIGIN } : null),
    [valid, videoId],
  );

  useEffect(() => {
    if (!valid) onError();
  }, [valid, onError]);

  return (
    <View
      onLayout={(event) => setWidth(Math.max(200, event.nativeEvent.layout.width))}
      style={[styles.viewport, { height: Math.max(200, (width * 9) / 16) }]}
    >
      {source ? (
        <WebView
          key={videoId}
          accessibilityLabel={`YouTube video: ${title}`}
          source={source}
          style={styles.player}
          // The WebView's default whitelist opens rejected origins in another app.
          // Intercept every scheme ourselves instead: only explicit outer UI opens links.
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(request) => allowNavigation(request, videoId)}
          onMessage={(event) => {
            if (event.nativeEvent.data === "youtube-error") onError();
          }}
          onError={onError}
          onHttpError={onError}
          onContentProcessDidTerminate={onError}
          onRenderProcessGone={onError}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction
          allowsPictureInPictureMediaPlayback={false}
          allowsAirPlayForMediaPlayback={false}
          allowsBackForwardNavigationGestures={false}
          allowsLinkPreview={false}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    width: "100%",
    minWidth: 200,
    minHeight: 200,
  },
  player: {
    flex: 1,
    backgroundColor: "#000",
  },
});
