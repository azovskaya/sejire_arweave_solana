/** Attach the link so file downloads also work in browsers that require it in the DOM. */
export function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser start reading the Blob before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
