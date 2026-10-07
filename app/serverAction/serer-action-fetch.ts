"use server";

export async function fetchData(url: string, options?: RequestInit) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store", // optional: disables caching on the server
      ...options,
    });

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    console.error("[fetchData] Error:", err);
    throw err;
  }
}
