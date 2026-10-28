import { createFileRoute } from "@tanstack/react-router";
import { handleVhost } from "@/lib/hub/api.server";

export const Route = createFileRoute("/api/vhost/$")({
  server: { handlers: { GET: ({ request }: { request: Request }) => handleVhost(request) } },
});
