import { useAccountAuth } from "@t3tools/client-runtime/account-auth-react";
import { useState, type ReactNode } from "react";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
export function useT3ConnectAccountPage(): {
  readonly open: (() => void) | null;
  readonly portals: ReactNode;
} {
  const { isSignedIn, user, signOut } = useAccountAuth();
  const [open, setOpen] = useState(false);
  return {
    open: isSignedIn ? () => setOpen(true) : null,
    portals: (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>T3 Connect account</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{user?.email ?? user?.name ?? "Signed in"}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{user?.id}</p>
          <T3ConnectUserProfilePage />
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </Button>
        </DialogContent>
      </Dialog>
    ),
  };
}
