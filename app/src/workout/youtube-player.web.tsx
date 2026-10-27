import { useEffect, useRef } from "react";

export type YouTubePlayerProps = {
  videoId: string;
  title: string;
  onError: () => void;
};

type YouTubePlayerInstance = {
  destroy: () => void;
  getIframe: () => HTMLIFrameElement;
};

type YouTubeApi = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      host: string;
      width: string;
      height: string;
      playerVars: {
        autoplay: 0;
        controls: 1;
        playsinline: 1;
        origin: string;
      };
      events: {
        onReady: (event: { target: YouTubePlayerInstance }) => void;
        onError: () => void;
      };
    },
  ) => YouTubePlayerInstance;
};

type YouTubeWindow = Window & {
  YT?: YouTubeApi;
  onYouTubeIframeAPIReady?: () => void;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
let apiPromise: Promise<YouTubeApi> | undefined;

/** Called only by a mounted demo, never by the exercise list or its launch button. */
function loadYouTubeApi(): Promise<YouTubeApi> {
  const youtubeWindow = window as YouTubeWindow;
  if (youtubeWindow.YT?.Player) return Promise.resolve(youtubeWindow.YT);
  if (apiPromise) return apiPromise;

  const { promise: attempt, resolve, reject } = Promise.withResolvers<YouTubeApi>();
  const previousReady = youtubeWindow.onYouTubeIframeAPIReady;
  const script = document.createElement("script");
  const restoreReady = () => {
    if (youtubeWindow.onYouTubeIframeAPIReady === ready) {
      youtubeWindow.onYouTubeIframeAPIReady = previousReady;
    }
  };
  const fail = () => {
    restoreReady();
    script.remove();
    reject(new Error("YouTube player API unavailable"));
  };
  const ready = () => {
    try {
      previousReady?.();
    } finally {
      restoreReady();
      if (youtubeWindow.YT?.Player) {
        resolve(youtubeWindow.YT);
      } else {
        fail();
      }
    }
  };

  apiPromise = attempt;
  // A failed attempt stays failed for its current consumers; reopening can try again.
  void attempt.catch(() => {
    if (apiPromise === attempt) apiPromise = undefined;
  });
  youtubeWindow.onYouTubeIframeAPIReady = ready;
  script.src = "https://www.youtube.com/iframe_api";
  script.async = true;
  script.addEventListener("error", fail, { once: true });
  document.head.appendChild(script);
  return attempt;
}

export function YouTubePlayer({ videoId, title, onError }: YouTubePlayerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef(onError);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let player: YouTubePlayerInstance | undefined;
    const container = containerRef.current;
    const reportError = () => {
      if (!cancelled && !failed) {
        failed = true;
        errorRef.current();
      }
    };

    if (videoId.length !== 11 || !VIDEO_ID.test(videoId) || !container) {
      reportError();
      return undefined;
    }

    const configureIframe = (instance: YouTubePlayerInstance) => {
      const iframe = instance.getIframe();
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.title = title;
      iframe.style.border = "0";
      iframe.style.position = "absolute";
      iframe.style.inset = "0";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
    };

    void loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        // YouTube replaces this child. React owns only the surrounding container.
        const mount = document.createElement("div");
        container.appendChild(mount);
        player = new api.Player(mount, {
          videoId,
          host: "https://www.youtube-nocookie.com",
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: 0,
            controls: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: ({ target }) => {
              if (!cancelled) configureIframe(target);
            },
            onError: reportError,
          },
        });
        configureIframe(player);
      })
      .catch(reportError);

    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } finally {
        container.replaceChildren();
      }
    };
  }, [videoId, title]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        minWidth: 200,
        minHeight: 200,
        aspectRatio: "16 / 9",
      }}
    />
  );
}
