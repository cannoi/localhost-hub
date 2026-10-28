import { createFileRoute } from "@tanstack/react-router";
import { handleLogs } from "@/lib/hub/api.server";

export const Route = createFileRoute("/api/logs")({
  server: { handlers: { GET: ({ request }: { request: Request }) => handleLogs(request) } },
});
