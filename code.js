figma.showUI(__html__, { width: 380, height: 580, themeColors: true });

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
      const summary = buildDesignSummary(node);
      figma.ui.postMessage({ type: 'design-data', summary, nodeName: node.name });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: 'Could not read design: ' + e.message });
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

function rgbStr(c) {
  return `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`;
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

function walkNodes(node, depth, textItems, interactiveItems, colorSet) {
  if (!node.visible) return;
  if (depth > 6) return;

  // Track fills for color palette
  if ('fills' in node && node.fills !== figma.mixed) {
    node.fills.forEach(f => {
      if (f.type === 'SOLID' && f.visible !== false) {
        colorSet.add(hexStr(f.color));
      }
    });
  }

  // Text nodes
  if (node.type === 'TEXT') {
    const fontSize = node.fontSize === figma.mixed ? 'mixed' : node.fontSize;
    const fontWeight = node.fontWeight === figma.mixed ? 'mixed' : node.fontWeight;
    const chars = node.characters.slice(0, 80).replace(/\n/g, ' ');

    let textColor = null;
    if (node.fills !== figma.mixed && node.fills.length > 0) {
      const sf = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (sf) textColor = sf.color;
    }

    const bgColor = findBackground(node);
    let contrastInfo = 'unknown background';
    let contrastValue = null;
    if (textColor && bgColor) {
      contrastValue = contrastRatio(textColor, bgColor);
      const isLargeText = (typeof fontSize === 'number' && fontSize >= 18) ||
                          (typeof fontSize === 'number' && fontSize >= 14 && fontWeight >= 700);
      const threshold = isLargeText ? 3.0 : 4.5;
      const pass = contrastValue >= threshold;
      contrastInfo = `${contrastValue}:1 ${pass ? '✓ PASSES' : `⚠️ FAILS (need ${threshold}:1)`}`;
    }

    textItems.push({
      name: node.name,
      chars: chars || '(empty)',
      fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
      fontWeight: typeof fontWeight === 'number' ? fontWeight : fontWeight,
      color: textColor ? hexStr(textColor) : 'unknown',
      contrastInfo,
      contrastValue,
      width: Math.round(node.width),
      height: Math.round(node.height)
    });
    return;
  }

  // Interactive components
  if (looksInteractive(node) && depth > 0) {
    const hasText = hasTextChildren(node);
    const w = Math.round(node.width);
    const h = Math.round(node.height);
    const touchOk = w >= 44 && h >= 44;
    const isIconOnly = !hasText && (w < 40 || h < 40);

    interactiveItems.push({
      name: node.name,
      type: node.type,
      width: w,
      height: h,
      hasTextLabel: hasText,
      touchTargetOk: touchOk,
      isIconOnly,
      touchInfo: touchOk
        ? `${w}×${h}px ✓ touch target OK`
        : `${w}×${h}px ⚠️ SMALL (need 44×44px min)`
    });
  }

  if ('children' in node) {
    node.children.forEach(child => walkNodes(child, depth + 1, textItems, interactiveItems, colorSet));
  }
}

// ─── DESIGN SUMMARY BUILDER ──────────────────────────────────────────────────

function buildDesignSummary(rootNode) {
  const textItems = [];
  const interactiveItems = [];
  const colorSet = new Set();

  // Root dimensions
  const w = Math.round(rootNode.width);
  const h = Math.round(rootNode.height);
  const isMobile = w <= 428;

  walkNodes(rootNode, 0, textItems, interactiveItems, colorSet);

  // Count issues
  const contrastFails = textItems.filter(t => t.contrastInfo.includes('FAILS'));
  const touchFails    = interactiveItems.filter(i => !i.touchTargetOk);
  const iconOnly      = interactiveItems.filter(i => i.isIconOnly);
  const tinyText      = textItems.filter(t => {
    const n = parseFloat(t.fontSize);
    return !isNaN(n) && n < 14;
  });

  let lines = [];
  lines.push(`FIGMA FRAME: "${rootNode.name}" (${w}×${h}px, ${isMobile ? 'mobile' : 'desktop/tablet'})`);
  lines.push('');

  // Text elements
  lines.push('=== TEXT ELEMENTS ===');
  if (textItems.length === 0) {
    lines.push('No text nodes found.');
  } else {
    textItems.forEach((t, i) => {
      lines.push(`[T${i+1}] Layer "${t.name}" — "${t.chars}" — ${t.fontSize} / weight ${t.fontWeight} — color ${t.color} — Contrast: ${t.contrastInfo}`);
    });
  }
  lines.push('');

  // Interactive elements
  lines.push('=== INTERACTIVE ELEMENTS ===');
  if (interactiveItems.length === 0) {
    lines.push('No interactive components detected.');
  } else {
    interactiveItems.forEach((el, i) => {
      const labelNote = el.isIconOnly ? ' — ⚠️ ICON ONLY (no text label)' : (el.hasTextLabel ? ' — has text label' : ' — no text label detected');
      lines.push(`[I${i+1}] "${el.name}" (${el.type}) — ${el.touchInfo}${labelNote}`);
    });
  }
  lines.push('');

  // Metrics summary
  lines.push('=== QUICK METRICS ===');
  lines.push(`Total text nodes: ${textItems.length}`);
  lines.push(`Contrast failures: ${contrastFails.length} of ${textItems.filter(t=>t.contrastInfo!=='unknown background').length} measured`);
  lines.push(`Touch target failures: ${touchFails.length} of ${interactiveItems.length} interactive elements`);
  lines.push(`Icon-only elements (no text alternative): ${iconOnly.length}`);
  lines.push(`Text smaller than 14px: ${tinyText.length}`);
  lines.push(`Unique colors in palette: ${colorSet.size}`);
  lines.push(`Color palette: ${Array.from(colorSet).slice(0,12).join(', ')}`);

  return lines.join('\n');
}
