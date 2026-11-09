import { documentClass } from "./layout";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { Provider } from "@react-spectrum/s2/Provider";
import { ToastContainer } from "@react-spectrum/s2/Toast";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import App from "./App";
import { destinations } from "./navigation";

function Root() {
  const router = useRouter();
  return (
    <Provider
      locale="en-US"
      colorScheme="dark"
      background="base"
      router={{
        navigate: (to) => {
          void router.navigate({ to });
        },
      }}
      styles={style({ minHeight: "screen", font: "body" })}
    >
      <Outlet />
      <ToastContainer placement="bottom" />
    </Provider>
  );
}

const rootRoute = createRootRoute({ component: Root });
const routes = [...Object.values(destinations), "/identity" as const].map(
  (path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: App,
    }),
);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    ...(history === undefined ? {} : { history }),
    routeTree: rootRoute.addChildren(routes),
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main className={style({ padding: 32 })}>
        <h1 className={documentClass("h1")}>Page not found</h1>
        <a className={documentClass("a")} href="/">
          Return to your companion
        </a>
      </main>
    ),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
