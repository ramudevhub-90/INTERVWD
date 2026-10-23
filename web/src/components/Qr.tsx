import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// QR codes for invite links: on screen, downloaded as an image, or printed on a poster.
// Scanned links carry ?src=qr, so Reports can show how many people came from a poster.

export function qrLink(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}src=qr`;
}

export function Qr({ url, size = 180 }: { url: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111426', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [url]);
  return <div className="qr" style={{ width: size, height: size }} role="img" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export async function downloadQr(url: string, filename: string) {
  const data = await QRCode.toDataURL(url, { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
  const a = Object.assign(document.createElement('a'), { href: data, download: `${filename}.png` });
  a.click();
}
