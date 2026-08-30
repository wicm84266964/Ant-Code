import type { TuiAppProps } from "./types.ts";
import { useTuiAppCore } from "./app-core.ts";
import { useTuiAppPanels } from "./app-panels.ts";
import { useTuiAppActions } from "./app-actions.ts";
import { useTuiAppTurn } from "./app-turn.ts";
import { useTuiAppKeys } from "./app-keys.ts";
import { renderTuiAppView } from "./app-view.ts";

function TuiApp(props: TuiAppProps) {
  const s0 = useTuiAppCore(props);
  const s1 = useTuiAppPanels(s0);
  const s2 = useTuiAppActions(s1);
  const s3 = useTuiAppTurn(s2);
  const s4 = useTuiAppKeys(s3);
  return renderTuiAppView(s4);
}

export { TuiApp };
