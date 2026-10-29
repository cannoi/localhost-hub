import { createFileRoute } from "@tanstack/react-router";
import { handleHealth } from "@/lib/hub/api.server";

export const Route = createFileRoute("/health")({
  server: { handlers: { GET: ({ request }: { request: Request }) => handleHealth(request) } },
});
