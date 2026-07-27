/**
 * src/lib/imageCompress.ts
 *
 * Client-side helper for compressing high-resolution phone camera photos before
 * storing them in sessionStorage or uploading to API endpoints.
 *
 * Phone cameras produce 12MB–48MB images that exceed sessionStorage quotas (5MB)
 * and slow down network uploads. This resizes images to max 1200px dimension
 * and compresses JPEG quality to ~0.82, producing ~150KB–300KB data URLs.
 */

export function compressImage(
  file: File,
  maxDimension = 1200,
  quality = 0.82
): Promise<string> {
  return new Promise((resolve, reject) => {
    // If file is very small (< 300KB), convert directly
    if (file.size < 300 * 1024) {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read small image file"));
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;

      // Scale down proportionally if larger than maxDimension
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }

      // Draw and compress to JPEG
      ctx.drawImage(img, 0, 0, width, height);
      const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve(compressedDataUrl);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load photo for compression"));
    };

    img.src = objectUrl;
  });
}
