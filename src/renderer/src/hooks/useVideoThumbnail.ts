/**
 * useVideoThumbnail — offline video-thumbnail generation via <video> → canvas (web pipeline
 * port). Desktop version takes any playable src instead of a decrypted data URL: media:// URLs
 * for saved drops, blob: object URLs for files still being created. Everything stays local —
 * zero network.
 */
import { useState, useEffect } from 'react';

export function useVideoThumbnail(src: string | null, mimeType?: string): { thumbnailUrl: string | null; isGenerating: boolean } {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!src || !mimeType?.startsWith('video/')) {
      setThumbnailUrl(null);
      setIsGenerating(false);
      return;
    }

    let cancelled = false;

    setIsGenerating(true);

    const generate = async () => {
      try {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;

        const loaded = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
          video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
          video.onerror = () => { clearTimeout(timeout); reject(new Error('video load error')); };
        });

        video.src = src;
        await loaded;
        if (cancelled) return;

        // Seek to 1 second (or 10% in for very short clips).
        video.currentTime = Math.min(1, video.duration * 0.1);

        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
        });
        if (cancelled) return;

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 160;
        canvas.height = video.videoHeight || 90;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setIsGenerating(false);
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const thumbnail = canvas.toDataURL('image/jpeg', 0.6);

        if (!cancelled) {
          setThumbnailUrl(thumbnail);
          setIsGenerating(false);
        }
      } catch {
        if (!cancelled) {
          setThumbnailUrl(null);
          setIsGenerating(false);
        }
      }
    };

    generate();

    return () => {
      cancelled = true;
    };
  }, [src, mimeType]);

  return { thumbnailUrl, isGenerating };
}
