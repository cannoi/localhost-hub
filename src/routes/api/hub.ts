import { createFileRoute } from "@tanstack/react-router";
import { handleHub } from "@/lib/hub/api.server";

const handle = ({ request }: { request: Request }) => handleHub(request);

export const Route = createFileRoute("/api/hub")({
  server: { handlers: { GET: handle, POST: handle } },
});
