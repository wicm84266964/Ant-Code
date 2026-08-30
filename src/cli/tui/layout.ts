export type TuiFrameBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export type TuiFrameRows = {
  bodyRows?: number;
  panelRows?: number;
  footerRows?: number;
  permissionFooterRows?: number;
  promptRows?: number;
};

export type TuiFrameOptions = {
  width?: number;
  height?: number;
  wide?: boolean;
  rows?: TuiFrameRows;
};

export function resolveTuiFrame(options: TuiFrameOptions = {}) {
  const width = Math.max(40, Number(options.width) || 100);
  const height = Math.max(12, Number(options.height) || 30);
  const rows = options.rows ?? {};
  const wide = Boolean(options.wide);
  const sidePanelWidth = wide ? Math.min(38, Math.max(32, Math.floor(width * 0.32))) : 0;
  const mainWidth = wide ? Math.max(50, width - sidePanelWidth - 1) : width;
  const bodyTop = 2;
  const bodyHeight = Math.max(1, Number(rows.bodyRows) || Math.max(1, height - 4));
  const bodyBottom = bodyTop + bodyHeight - 1;
  const panelRows = Math.max(0, Number(rows.panelRows) || 0);
  const panelTop = bodyBottom + 1;
  const footerRows = Number(rows.footerRows) || 1;
  const permissionFooterRows = Number(rows.permissionFooterRows) || 0;
  const promptRows = Number(rows.promptRows) || 3;
  const promptTop = Math.max(1, height - footerRows - permissionFooterRows - promptRows + 1);
  const panelRegion = panelRows > 0 ? box(1, panelTop, width, panelRows) : null;

  return {
    width,
    height,
    wide,
    sidePanelWidth,
    mainWidth,
    regions: {
      status: box(1, 1, width, 1),
      body: box(1, bodyTop, width, bodyHeight),
      transcript: box(1, bodyTop, mainWidth, bodyHeight),
      side: wide ? box(mainWidth + 2, bodyTop, sidePanelWidth, bodyHeight) : null,
      panel: panelRegion,
      overlay: panelRegion,
      prompt: box(1, promptTop, width, promptRows),
      permissionFooter: permissionFooterRows > 0 ? box(1, promptTop + promptRows, width, permissionFooterRows) : null,
      footer: box(1, height, width, 1)
    }
  };
}

type TuiScrollPoint = {
  x?: number;
  y?: number;
};

type TuiScrollTargetOptions = {
  defaultTarget?: string;
  activeOverlay?: boolean;
};

export function resolveScrollTarget(mouseEvent: TuiScrollPoint | null | undefined, frame: ReturnType<typeof resolveTuiFrame> | null | undefined, options: TuiScrollTargetOptions = {}) {
  if (!mouseEvent || !Number.isFinite(mouseEvent.x) || !Number.isFinite(mouseEvent.y)) {
    return options.defaultTarget ?? "transcript";
  }
  if (options.activeOverlay && contains(frame?.regions.overlay, mouseEvent)) {
    return "overlay";
  }
  if (contains(frame?.regions.side, mouseEvent)) {
    return "side";
  }
  if (contains(frame?.regions.transcript, mouseEvent)) {
    return "transcript";
  }
  return options.defaultTarget ?? "transcript";
}

export function contains(region: TuiFrameBox | null | undefined, point: TuiScrollPoint | null | undefined) {
  if (!region || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return false;
  }
  const x = Number(point.x);
  const y = Number(point.y);
  return x >= region.left
    && x <= region.right
    && y >= region.top
    && y <= region.bottom;
}

function box(left: number, top: number, width: number, height: number): TuiFrameBox {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  return {
    left,
    top,
    width: safeWidth,
    height: safeHeight,
    right: left + safeWidth - 1,
    bottom: top + safeHeight - 1
  };
}
