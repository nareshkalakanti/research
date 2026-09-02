/** Parse fetch body as JSON; surface HTML/error pages clearly. */
export async function parseFetchJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Empty response from server (${res.status})`);
  }
  if (text.trimStart().startsWith("<")) {
    throw new Error(
      res.ok
        ? "Server returned HTML instead of JSON — try refreshing the page"
        : `Server error (${res.status}) — check the dev console or restart npm run dev`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      res.ok
        ? "Invalid JSON from server — try again"
        : `Request failed (${res.status}) — invalid server response`,
    );
  }
}
