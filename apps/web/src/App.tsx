import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { EmptyState, Link } from "./components/ui";
import { navigate, queryParam, resolveRoute, useLocation, type RouteDef } from "./lib/router";
import { DocumentPage } from "./pages/DocumentPage";
import { LoginPage } from "./pages/LoginPage";
import { SearchPage } from "./pages/SearchPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { useSessionUser } from "./state/app";

type RouteName = "home" | "login" | "workspace" | "tasks" | "activity" | "members" | "document" | "search";

export const ROUTES: readonly RouteDef<RouteName>[] = [
  { name: "home", pattern: "/" },
  { name: "login", pattern: "/login" },
  { name: "workspace", pattern: "/w/:workspaceId" },
  { name: "tasks", pattern: "/w/:workspaceId/tasks" },
  { name: "activity", pattern: "/w/:workspaceId/activity" },
  { name: "members", pattern: "/w/:workspaceId/members" },
  { name: "document", pattern: "/d/:documentId" },
  { name: "search", pattern: "/search" },
];

export function App() {
  const location = useLocation();
  const user = useSessionUser();
  const route = resolveRoute(ROUTES, location.split("?")[0] ?? "/");

  useEffect(() => {
    if (!user && route?.name !== "login") navigate("/login", { replace: true });
    if (user && route?.name === "login") navigate("/", { replace: true });
  }, [user, route?.name]);

  if (!user) return <LoginPage />;

  let page;
  switch (route?.name) {
    case "home":
    case "login":
      page = <WorkspacesPage />;
      break;
    case "workspace":
      page = <WorkspacePage workspaceId={route.params.workspaceId as string} tab="documents" />;
      break;
    case "tasks":
    case "activity":
    case "members":
      page = <WorkspacePage workspaceId={route.params.workspaceId as string} tab={route.name} />;
      break;
    case "document":
      page = <DocumentPage key={route.params.documentId} documentId={route.params.documentId as string} />;
      break;
    case "search":
      page = <SearchPage query={queryParam(location, "q") ?? ""} />;
      break;
    default:
      page = (
        <EmptyState title="Page not found">
          <Link to="/">Go to your workspaces</Link>
        </EmptyState>
      );
  }
  return <Layout>{page}</Layout>;
}
