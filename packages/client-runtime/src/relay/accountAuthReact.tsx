import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createAccountAuth,
  type AccountCredentialStore,
  type AccountUser,
  type DeviceAuthorization,
} from "./accountAuth.ts";
interface AccountAuthState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: AccountUser | null;
  readonly device: DeviceAuthorization | null;
  readonly error: string | null;
  readonly getToken: (_options?: unknown) => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly cancelSignIn: () => void;
}
const AccountContext = createContext<AccountAuthState>({
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  user: null,
  device: null,
  error: null,
  getToken: async () => null,
  signIn: async () => {},
  signOut: async () => {},
  cancelSignIn: () => {},
});
export function AccountAuthProvider(props: {
  readonly relayUrl: string;
  readonly clientId: string;
  readonly store: AccountCredentialStore;
  readonly openBrowser: (url: string) => void | Promise<unknown>;
  readonly children: ReactNode;
}) {
  const { relayUrl, clientId, store, openBrowser } = props;
  const client = useMemo(
    () => createAccountAuth({ relayUrl, clientId, store }),
    [relayUrl, clientId, store],
  );
  const [isLoaded, setLoaded] = useState(false);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .restore()
      .catch(() => {
        if (active) setError("Could not read your saved account session.");
      })
      .finally(() => {
        if (active) {
          setUser(client.user);
          setLoaded(true);
        }
      });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [client]);
  const getToken = useCallback(async () => {
    try {
      return await client.getToken();
    } finally {
      setUser(client.user);
    }
  }, [client]);
  const cancelSignIn = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setDevice(null);
    setError(null);
  }, []);
  const signIn = useCallback(async () => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setError(null);
    try {
      await client.login((authorization) => {
        setDevice(authorization);
        void Promise.resolve(
          openBrowser(authorization.verification_uri_complete ?? authorization.verification_uri),
        ).catch(() => setError("Open the approval link to finish signing in."));
      }, current.signal);
      setUser(client.user);
      setDevice(null);
    } catch (failure) {
      if (!current.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Sign-in failed.");
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }, [client, openBrowser]);
  const signOut = useCallback(async () => {
    cancelSignIn();
    setError(null);
    try {
      await client.logout();
    } catch {
      setError(
        "Signed out locally. The relay could not revoke this session; it will expire automatically.",
      );
    } finally {
      setUser(null);
    }
  }, [client, cancelSignIn]);
  const value = useMemo(
    () => ({
      isLoaded,
      isSignedIn: user !== null,
      userId: user?.id ?? null,
      user,
      device,
      error,
      getToken,
      signIn,
      signOut,
      cancelSignIn,
    }),
    [isLoaded, user, device, error, getToken, signIn, signOut, cancelSignIn],
  );
  return <AccountContext.Provider value={value}>{props.children}</AccountContext.Provider>;
}
export function useAccountAuth(_options?: unknown) {
  return useContext(AccountContext);
}
