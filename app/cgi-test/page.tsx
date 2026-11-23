import { fetchIproRange } from "../serverAction/ipro-action";

export const dynamic = "force-dynamic";

export default async function Page() {
  const result = await fetchIproRange();

  return (
    <main>
      <h1>i-PRO CGI Test</h1>

      <pre>{result}</pre>
    </main>
  );
}
