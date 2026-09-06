export function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isLightColor(color) {
  let hex = color;
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
    const m = hex.match(/[\d.]+/g);
    if (m) return (parseFloat(m[0]) * 299 + parseFloat(m[1]) * 587 + parseFloat(m[2]) * 114) / 1000 > 128;
    return false;
  }
  if (hex.startsWith('#')) {
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2), 16), g = parseInt(hex.slice(2,4), 16), b = parseInt(hex.slice(4,6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  }
  return false;
}

function relativeLuminance(color) {
  let channels;
  if (String(color).startsWith('#')) {
    let hex = String(color).slice(1);
    if (hex.length === 3) hex = hex.split('').map(value => value + value).join('');
    channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(value => parseInt(value, 16));
  } else {
    channels = (String(color).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  }
  if (channels.length !== 3 || channels.some(Number.isNaN)) return 0;
  const [r, g, b] = channels.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastText(background, dark = '#101410', light = '#f7f9f6') {
  const bg = relativeLuminance(background);
  const darkRatio = (bg + 0.05) / (relativeLuminance(dark) + 0.05);
  const lightRatio = (relativeLuminance(light) + 0.05) / (bg + 0.05);
  return darkRatio >= lightRatio ? dark : light;
}
