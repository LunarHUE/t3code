import { useAccountAuth } from "@t3tools/client-runtime/account-auth-react";
import { useState, type ReactNode } from "react";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
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
        <DialogContent className="max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>T3 Connect account</DialogTitle>
            <DialogDescription>{user?.email ?? user?.name ?? "Signed in"}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <T3ConnectUserProfilePage />
          </DialogPanel>
          <DialogFooter variant="bare">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  void signOut();
                }}
              >
                Sign out
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}
