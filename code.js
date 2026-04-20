figma.showUI(__html__, { width: 380, height: 580, themeColors: true });

// ─── STATE ───────────────────────────────────────────────────────────────────

let currentNodeId   = null;
let currentFrameMeta = null; // { x, y, w, h, name, nodePositions, violations }

// ─── MESSAGING ──────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'load-key') {
    const key = await figma.clientStorage.getAsync('anthropic-key') || '';
    figma.ui.postMessage({ type: 'key', key });
  }

  if (msg.type === 'save-key') {
    await figma.clientStorage.setAsync('anthropic-key', msg.key);
  }

  if (msg.type === 'analyze') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'error', message: 'Select a frame or component first.' });
      return;
    }
    const node = sel[0];
    try {
      const { summary, nodePositions, violations } = buildDesignSummary(node);
      currentNodeId = node.id;
      currentFrameMeta = {
        name: node.name,
        x: node.x, y: node.y,
        w: Math.round(node.width),
        h: Math.round(node.height),
        nodePositions,
        violations
      };
      figma.ui.postMessage({
        type: 'design-data',
        summary,
        nodeName: node.name,
        violations,
        violationCount: violations.length
      });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: 'Could not read design: ' + e.message });
    }
  }

  if (msg.type === 'create-annotations') {
    try {
      const count = await createAnnotatedFrame();
      figma.ui.postMessage({ type: 'annotations-done', count });
    } catch (e) {
      figma.ui.postMessage({ type: 'annotation-error', message: e.message });
    }
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// ─── LUMINANCE & CONTRAST ────────────────────────────────────────────────────

function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(r, g, b) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(c1, c2) {
  const l1 = luminance(c1.r, c1.g, c1.b);
  const l2 = luminance(c2.r, c2.g, c2.b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

function hexStr(c) {
  const r = Math.round(c.r*255).toString(16).padStart(2,'0');
  const g = Math.round(c.g*255).toString(16).padStart(2,'0');
  const b = Math.round(c.b*255).toString(16).padStart(2,'0');
  return '#'+r+g+b;
}

// ─── BACKGROUND FINDER ───────────────────────────────────────────────────────

function findBackground(node) {
  let current = node.parent;
  while (current) {
    if ('fills' in current && current.fills !== figma.mixed) {
      const solidFill = current.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (solidFill) return solidFill.color;
    }
    current = current.parent;
  }
  return null;
}

// ─── INTERACTIVE ELEMENT DETECTION ──────────────────────────────────────────

const INTERACTIVE_KEYWORDS = /button|btn|input|field|link|tab|nav|menu|toggle|checkbox|radio|select|dropdown|cta|action|click|tap|icon/i;

function looksInteractive(node) {
  return INTERACTIVE_KEYWORDS.test(node.name) ||
    node.type === 'COMPONENT' ||
    node.type === 'INSTANCE';
}

function hasTextChildren(node) {
  if (!('children' in node)) return false;
  return node.children.some(c => c.type === 'TEXT' || hasTextChildren(c));
}

// ─── NODE TREE WALKER ────────────────────────────────────────────────────────

function walkNodes(node, depth, textItems, interactiveItems, colorSet, nodePositions, rootBounds) {
  if (!node.visible) return;
  if (depth > 6) return;

  // Record position relative to root frame
  if (node.absoluteBoundingBox && rootBounds) {
    nodePositions[node.name] = {
      relX: Math.round(node.absoluteBoundingBox.x - rootBounds.x),
      relY: Math.round(node.absoluteBoundingBox.y - rootBounds.y),
      w:    Math.round(node.absoluteBoundingBox.width),
      h:    Math.round(node.absoluteBoundingBox.height)
    };
  }

  // Track fills for color palette
  if ('fills' in node && node.fills !== figma.mixed) {
    node.fills.forEach(f => {
      if (f.type === 'SOLID' && f.visible !== false) colorSet.add(hexStr(f.color));
    });
  }

  // Text nodes
  if (node.type === 'TEXT') {
    const fontSize   = node.fontSize   === figma.mixed ? 'mixed' : node.fontSize;
    const fontWeight = node.fontWeight === figma.mixed ? 'mixed' : node.fontWeight;
    const chars      = node.characters.slice(0, 80).replace(/\n/g, ' ');

    let textColor = null;
    if (node.fills !== figma.mixed && node.fills.length > 0) {
      const sf = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (sf) textColor = sf.color;
    }

    const bgColor = findBackground(node);
    let contrastInfo  = 'unknown background';
    let contrastValue = null;
    if (textColor && bgColor) {
      contrastValue = contrastRatio(textColor, bgColor);
      const isLarge  = (typeof fontSize === 'number' && fontSize >= 18) ||
                       (typeof fontSize === 'number' && fontSize >= 14 && fontWeight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;
      const pass      = contrastValue >= threshold;
      contrastInfo    = `${contrastValue}:1 ${pass ? '✓ PASSES' : `⚠️ FAILS (need ${threshold}:1)`}`;
    }

    textItems.push({
      name: node.name, chars: chars || '(empty)',
      fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
      fontWeight: typeof fontWeight === 'number' ? fontWeight : fontWeight,
      color: textColor ? hexStr(textColor) : 'unknown',
      contrastInfo, contrastValue,
      width: Math.round(node.width), height: Math.round(node.height)
    });
    return;
  }

  // Interactive components
  if (looksInteractive(node) && depth > 0) {
    const hasText  = hasTextChildren(node);
    const w        = Math.round(node.width);
    const h        = Math.round(node.height);
    const touchOk  = w >= 44 && h >= 44;
    const isIconOnly = !hasText && (w < 40 || h < 40);
    interactiveItems.push({
      name: node.name, type: node.type,
      width: w, height: h,
      hasTextLabel: hasText,
      touchTargetOk: touchOk,
      isIconOnly,
      touchInfo: touchOk
        ? `${w}×${h}px ✓ touch target OK`
        : `${w}×${h}px ⚠️ SMALL (need 44×44px min)`
    });
  }

  if ('children' in node) {
    node.children.forEach(child =>
      walkNodes(child, depth + 1, textItems, interactiveItems, colorSet, nodePositions, rootBounds)
    );
  }
}

// ─── DESIGN SUMMARY BUILDER ──────────────────────────────────────────────────

function buildDesignSummary(rootNode) {
  const textItems       = [];
  const interactiveItems = [];
  const colorSet        = new Set();
  const nodePositions   = {};
  const rootBounds      = rootNode.absoluteBoundingBox;

  const w = Math.round(rootNode.width);
  const h = Math.round(rootNode.height);

  walkNodes(rootNode, 0, textItems, interactiveItems, colorSet, nodePositions, rootBounds);

  const contrastFails = textItems.filter(t => t.contrastInfo.includes('FAILS'));
  const touchFails    = interactiveItems.filter(i => !i.touchTargetOk);
  const iconOnly      = interactiveItems.filter(i => i.isIconOnly);
  const tinyText      = textItems.filter(t => { const n = parseFloat(t.fontSize); return !isNaN(n) && n < 14; });

  // Build violations list for annotation
  const violations = [
    ...contrastFails.map(t => ({
      layerName: t.name,
      type: 'contrast',
      severity: t.contrastValue < 2.5 ? 'critical' : 'high',
      issue: `Contrast ${t.contrastValue}:1 — FAILS WCAG`
    })),
    ...touchFails.filter(i => !i.isIconOnly).map(i => ({
      layerName: i.name,
      type: 'touch-target',
      severity: 'medium',
      issue: `Touch target ${i.width}×${i.height}px (min 44×44)`
    })),
    ...iconOnly.map(i => ({
      layerName: i.name,
      type: 'icon-only',
      severity: 'high',
      issue: `Icon only — no text alternative`
    })),
    ...tinyText.map(t => ({
      layerName: t.name,
      type: 'text-size',
      severity: 'medium',
      issue: `Text too small: ${t.fontSize}`
    }))
  ];

  // Build summary text for agents
  const lines = [];
  lines.push(`FIGMA FRAME: "${rootNode.name}" (${w}×${h}px, ${w <= 428 ? 'mobile' : 'desktop/tablet'})`);
  lines.push('');
  lines.push('=== TEXT ELEMENTS ===');
  if (textItems.length === 0) {
    lines.push('No text nodes found.');
  } else {
    textItems.forEach((t, i) => {
      lines.push(`[T${i+1}] Layer "${t.name}" — "${t.chars}" — ${t.fontSize} / weight ${t.fontWeight} — color ${t.color} — Contrast: ${t.contrastInfo}`);
    });
  }
  lines.push('');
  lines.push('=== INTERACTIVE ELEMENTS ===');
  if (interactiveItems.length === 0) {
    lines.push('No interactive components detected.');
  } else {
    interactiveItems.forEach((el, i) => {
      const labelNote = el.isIconOnly
        ? ' — ⚠️ ICON ONLY (no text label)'
        : el.hasTextLabel ? ' — has text label' : ' — no text label detected';
      lines.push(`[I${i+1}] "${el.name}" (${el.type}) — ${el.touchInfo}${labelNote}`);
    });
  }
  lines.push('');
  lines.push('=== QUICK METRICS ===');
  lines.push(`Total text nodes: ${textItems.length}`);
  lines.push(`Contrast failures: ${contrastFails.length} of ${textItems.filter(t=>t.contrastInfo!=='unknown background').length} measured`);
  lines.push(`Touch target failures: ${touchFails.length} of ${interactiveItems.length} interactive elements`);
  lines.push(`Icon-only elements (no text alternative): ${iconOnly.length}`);
  lines.push(`Text smaller than 14px: ${tinyText.length}`);
  lines.push(`Unique colors in palette: ${colorSet.size}`);
  lines.push(`Color palette: ${Array.from(colorSet).slice(0,12).join(', ')}`);

  return { summary: lines.join('\n'), nodePositions, violations };
}

// ─── ANNOTATED FRAME CREATOR ─────────────────────────────────────────────────

const SEV_COLORS = {
  critical: { r: 0.937, g: 0.267, b: 0.267 },
  high:     { r: 0.976, g: 0.451, b: 0.090 },
  medium:   { r: 0.961, g: 0.620, b: 0.043 },
  low:      { r: 0.063, g: 0.725, b: 0.506 }
};

async function createAnnotatedFrame() {
  const meta = currentFrameMeta;
  if (!meta || !currentNodeId) throw new Error('No analysis data. Run analysis first.');

  const rootNode = figma.getNodeById(currentNodeId);
  if (!rootNode) throw new Error('Original frame not found. It may have been deleted.');

  // Load font — try Inter then Roboto
  let font = { family: 'Inter', style: 'Medium' };
  try { await figma.loadFontAsync(font); }
  catch {
    font = { family: 'Roboto', style: 'Medium' };
    try { await figma.loadFontAsync(font); }
    catch { throw new Error('Could not load fonts. Try again.'); }
  }

  // Export the original frame as PNG
  const bytes = await rootNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });

  // Create the annotation frame, placed to the right of the original
  const frame = figma.createFrame();
  frame.name = `${meta.name} — Accessibility Audit`;
  frame.x = meta.x + meta.w + 80;
  frame.y = meta.y;
  frame.resize(meta.w, meta.h);
  frame.clipsContent = false;

  // Set exported PNG as background fill
  const image = figma.createImage(bytes);
  frame.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

  // Place violation overlays
  let count = 0;
  for (const v of meta.violations) {
    const pos = meta.nodePositions[v.layerName];
    if (!pos) continue;
    count++;

    const color = SEV_COLORS[v.severity] || SEV_COLORS.medium;

    // Highlight rectangle
    const rect = figma.createRectangle();
    rect.name = `[${count}] ${v.layerName}`;
    rect.x = pos.relX;
    rect.y = pos.relY;
    rect.resize(Math.max(pos.w, 4), Math.max(pos.h, 4));
    rect.fills  = [{ type: 'SOLID', color, opacity: 0.15 }];
    rect.strokes = [{ type: 'SOLID', color }];
    rect.strokeWeight = 2;
    rect.cornerRadius = 3;
    frame.appendChild(rect);

    // Label background pill
    const labelH  = 20;
    const labelW  = Math.min(meta.w - pos.relX, 220);
    const labelY  = pos.relY > labelH + 6 ? pos.relY - labelH - 4 : pos.relY + pos.h + 4;
    const labelX  = Math.max(0, Math.min(pos.relX, meta.w - labelW));

    const pill = figma.createRectangle();
    pill.x = labelX;
    pill.y = labelY;
    pill.resize(labelW, labelH);
    pill.fills  = [{ type: 'SOLID', color, opacity: 0.92 }];
    pill.cornerRadius = 4;
    frame.appendChild(pill);

    // Label text
    const labelText = figma.createText();
    labelText.fontName = font;
    labelText.fontSize = 10;
    labelText.x = labelX + 5;
    labelText.y = labelY + 4;
    labelText.characters = `${count}. ${v.issue}`.slice(0, 36);
    labelText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    frame.appendChild(labelText);
  }

  // Select and scroll to the new frame
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  return count;
}
