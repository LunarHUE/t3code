import { createFileRoute } from "@tanstack/react-router";
import { ActionsSettings } from "../components/settings/ActionsSettings";

export const Route = createFileRoute("/settings/actions")({
  component: ActionsSettings,
});
