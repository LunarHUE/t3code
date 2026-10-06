import { useAccountAuth } from "@t3tools/client-runtime/account-auth-react";
export function useT3ConnectAuthPrompt() {
  const { signIn } = useAccountAuth();
  return {
    authPrompt: null,
    openAuthPrompt: () => {
      void signIn();
    },
  };
}
