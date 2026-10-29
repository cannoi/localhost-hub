import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/hub/dashboard";

export const Route = createFileRoute("/")({
  component: Dashboard,
});
