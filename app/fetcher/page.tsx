import { fetchData } from "../serverAction/serer-action-fetch";

export default async function Page() {
  const data = await fetchData("https://jsonplaceholder.typicode.com/posts");

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">Posts</h1>
      <ul className="space-y-1">
        {data.slice(0, 5).map((post: any) => (
          <li key={post.id} className="border-b pb-1">
            {post.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
