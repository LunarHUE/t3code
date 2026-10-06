import { createFileRoute, redirect } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ConnectCliAuthorizeSurface } from "../components/cloud/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    if (!hasCloudPublicConfig()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: ConnectCliAuthorizeSurface,
});
