// Apply the saved theme before first paint to avoid a flash. Kept as a file (not inline) so the CSP can forbid inline scripts.
try {
  var t = localStorage.getItem('weft:theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
