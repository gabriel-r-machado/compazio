export type PortalPageAction =
  "click" | "type" | "press" | "scroll" | "dom" | "accessibility" | "get" | "focus" | "viewport";

export interface PortalLocatorInput {
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly text?: string;
  readonly selector?: string;
  readonly coordinates?: { readonly x: number; readonly y: number };
  readonly exact?: boolean;
  readonly index?: number;
}

export interface PortalPageLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxChars: number;
  readonly maxTextChars: number;
  readonly maxClasses: number;
  readonly maxChildren: number;
}

export const defaultPortalPageLimits: PortalPageLimits = {
  maxNodes: 400,
  maxDepth: 12,
  maxChars: 40_000,
  maxTextChars: 240,
  maxClasses: 6,
  maxChildren: 60
};

export const maximumPortalPageLimits: PortalPageLimits = {
  maxNodes: 1_500,
  maxDepth: 24,
  maxChars: 120_000,
  maxTextChars: 2_000,
  maxClasses: 16,
  maxChildren: 200
};

/** A single key, never a scripted sequence: automation types text with `type`, not with chords. */
export const allowedPortalKeys = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space"
] as const;

export type PortalKey = (typeof allowedPortalKeys)[number];

export interface PortalPageRequest {
  readonly action: PortalPageAction;
  readonly locator?: PortalLocatorInput;
  readonly text?: string;
  readonly clear?: boolean;
  readonly key?: string;
  readonly modifiers?: readonly ("shift" | "control" | "alt" | "meta")[];
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
  readonly query?: string;
  readonly filter?: { readonly role?: string; readonly name?: string };
  readonly includeBounds?: boolean;
  readonly limits: PortalPageLimits;
}

export type PortalPageResponse =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

/**
 * Serialized into the page for every automation call. It must stay self-contained: no module
 * imports, no closures, no Electron. The page receives a plain description of what to do and
 * answers with plain data, which is what keeps remote content away from the main process.
 */
export function portalPageAgent(request: PortalPageRequest): PortalPageResponse {
  const limits = request.limits;
  const sensitivePattern =
    /pass|senha|secret|token|cvv|cvc|card|cart[aã]o|auth|otp|pin\b|security|credential/i;

  function collapse(value: string | null | undefined, maximum: number): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximum);
  }

  function safeUrl(value: string | null): string | undefined {
    if (value === null || value === "") return undefined;
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[oculto]`;
      return `${url.origin}${url.pathname}`.slice(0, 512);
    } catch {
      return undefined;
    }
  }

  function isElement(node: Node | null): node is Element {
    return node !== null && node.nodeType === 1;
  }

  function isHidden(element: Element): boolean {
    if (element.hasAttribute("hidden")) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
    return element.getClientRects().length === 0 && element.tagName !== "OPTION";
  }

  function fieldName(element: Element): string {
    return `${element.getAttribute("name") ?? ""} ${element.id} ${element.getAttribute("autocomplete") ?? ""}`;
  }

  function isSensitive(element: Element): boolean {
    if (
      element instanceof HTMLInputElement &&
      (element.type === "password" || element.type === "hidden")
    )
      return true;
    return sensitivePattern.test(fieldName(element));
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit.trim() !== "") return explicit.trim().split(/\s+/)[0] ?? "";
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select")
      return element instanceof HTMLSelectElement && element.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "dialog") return "dialog";
    if (tag === "output") return "status";
    if (tag === "progress") return "progressbar";
    if (tag === "iframe") return "iframe";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "password" || type === "hidden") return "textbox";
      return "textbox";
    }
    return "generic";
  }

  function labelFor(element: Element): string {
    if (element instanceof HTMLInputElement && element.labels !== null && element.labels.length > 0)
      return collapse(element.labels[0]?.textContent, limits.maxTextChars);
    if (
      (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
      element.labels !== null &&
      element.labels.length > 0
    )
      return collapse(element.labels[0]?.textContent, limits.maxTextChars);
    const wrapper = element.closest("label");
    if (wrapper !== null) return collapse(wrapper.textContent, limits.maxTextChars);
    return "";
  }

  function accessibleName(element: Element): string {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .filter((part) => part !== "");
      if (parts.length > 0) return collapse(parts.join(" "), limits.maxTextChars);
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "")
      return collapse(ariaLabel, limits.maxTextChars);
    const label = labelFor(element);
    if (label !== "") return label;
    if (element instanceof HTMLInputElement) {
      if (element.type === "button" || element.type === "submit" || element.type === "reset")
        return collapse(element.value, limits.maxTextChars);
      const placeholder = element.getAttribute("placeholder");
      if (placeholder !== null) return collapse(placeholder, limits.maxTextChars);
    }
    if (element instanceof HTMLImageElement) return collapse(element.alt, limits.maxTextChars);
    const title = element.getAttribute("title");
    if (title !== null && title.trim() !== "") return collapse(title, limits.maxTextChars);
    return collapse(element.textContent, limits.maxTextChars);
  }

  function safeValue(element: Element): string | undefined {
    if (isSensitive(element)) return undefined;
    if (element instanceof HTMLSelectElement) return collapse(element.value, 120);
    if (element instanceof HTMLTextAreaElement) return collapse(element.value, 120);
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") return undefined;
      return collapse(element.value, 120);
    }
    return undefined;
  }

  function statesOf(element: Element): Record<string, boolean> {
    const states: Record<string, boolean> = {};
    const ariaDisabled = element.getAttribute("aria-disabled");
    const disabled =
      ariaDisabled === "true" ||
      ((element instanceof HTMLInputElement ||
        element instanceof HTMLButtonElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
        element.disabled);
    if (disabled) states.disabled = true;
    const ariaChecked = element.getAttribute("aria-checked");
    if (ariaChecked === "true" || ariaChecked === "false") states.checked = ariaChecked === "true";
    else if (
      element instanceof HTMLInputElement &&
      (element.type === "checkbox" || element.type === "radio")
    )
      states.checked = element.checked;
    const ariaSelected = element.getAttribute("aria-selected");
    if (ariaSelected === "true" || ariaSelected === "false")
      states.selected = ariaSelected === "true";
    else if (element instanceof HTMLOptionElement) states.selected = element.selected;
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") states.expanded = expanded === "true";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.required) states.required = true;
      if (element.readOnly) states.readonly = true;
    }
    if (document.activeElement === element) states.focused = true;
    return states;
  }

  function boundsOf(element: Element): { x: number; y: number; width: number; height: number } {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function describe(element: Element): Record<string, unknown> {
    const described: Record<string, unknown> = {};
    described.tag = element.tagName.toLowerCase();
    described.role = roleOf(element);
    described.name = accessibleName(element);
    if (element.id !== "") described.id = collapse(element.id, 120);
    const value = safeValue(element);
    if (value !== undefined) described.value = value;
    described.states = statesOf(element);
    if (request.includeBounds === true) described.bounds = boundsOf(element);
    return described;
  }

  function matches(candidate: string, wanted: string, exact: boolean): boolean {
    const left = candidate.toLowerCase().trim();
    const right = wanted.toLowerCase().trim();
    return exact ? left === right : left.includes(right);
  }

  function candidates(): Element[] {
    return Array.from(document.querySelectorAll("*")).filter(
      (element) =>
        !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"].includes(
          element.tagName
        )
    );
  }

  function pick(found: Element[], index: number | undefined): Element | null {
    const visible = found.filter((element) => !isHidden(element));
    const pool = visible.length > 0 ? visible : found;
    return pool[index ?? 0] ?? null;
  }

  function locate(
    locator: PortalLocatorInput | undefined
  ): { element: Element; strategy: string } | null {
    if (locator === undefined) return null;
    const exact = locator.exact === true;
    if (locator.role !== undefined || locator.name !== undefined) {
      const found = candidates().filter((element) => {
        const roleOk = locator.role === undefined || roleOf(element) === locator.role.toLowerCase();
        const nameOk =
          locator.name === undefined || matches(accessibleName(element), locator.name, exact);
        return roleOk && nameOk && (locator.role !== undefined || locator.name !== undefined);
      });
      const element = pick(found, locator.index);
      if (element !== null) return { element, strategy: "role-name" };
    }
    if (locator.label !== undefined) {
      const found = candidates().filter(
        (element) =>
          element.matches("input, textarea, select, [contenteditable]") &&
          matches(labelFor(element), locator.label ?? "", exact)
      );
      const element = pick(found, locator.index);
      if (element !== null) return { element, strategy: "label" };
    }
    if (locator.text !== undefined) {
      const found = candidates().filter((element) => {
        if (element.children.length > 0 && !element.matches("button, a, label, option, summary"))
          return false;
        return matches(collapse(element.textContent, 400), locator.text ?? "", exact);
      });
      const element = pick(found, locator.index);
      if (element !== null) return { element, strategy: "text" };
    }
    if (locator.selector !== undefined) {
      let found: Element[];
      try {
        found = Array.from(document.querySelectorAll(locator.selector));
      } catch {
        return null;
      }
      const element = pick(found, locator.index);
      if (element !== null) return { element, strategy: "selector" };
    }
    if (locator.coordinates !== undefined) {
      const element = document.elementFromPoint(locator.coordinates.x, locator.coordinates.y);
      if (element !== null) return { element, strategy: "coordinates" };
    }
    return null;
  }

  function failure(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ): PortalPageResponse {
    return details === undefined
      ? { ok: false, code, message }
      : { ok: false, code, message, details };
  }

  function requireElement(): { element: Element; strategy: string } | PortalPageResponse {
    const located = locate(request.locator);
    if (located === null)
      return failure("PORTAL_ELEMENT_NOT_FOUND", "Elemento não encontrado no Portal.", {
        locator: request.locator ?? {}
      });
    return located;
  }

  function serializeNode(
    element: Element,
    depth: number,
    budget: { nodes: number; chars: number }
  ): unknown {
    budget.nodes += 1;
    if (budget.nodes > limits.maxNodes) throw new Error("PORTAL_DOM_LIMIT_EXCEEDED");
    const attributes: Record<string, string> = {};
    const allowed = [
      "type",
      "name",
      "role",
      "aria-label",
      "placeholder",
      "alt",
      "title",
      "for",
      "target",
      "lang",
      "data-testid"
    ];
    for (const attribute of allowed) {
      const value = element.getAttribute(attribute);
      if (value !== null && value !== "") attributes[attribute] = collapse(value, 160);
    }
    const href = element.getAttribute("href");
    if (href !== null) {
      const safe = safeUrl(href);
      if (safe !== undefined) attributes.href = safe;
    }
    const source = element.getAttribute("src");
    if (source !== null) {
      const safe = safeUrl(source);
      if (safe !== undefined) attributes.src = safe;
    }
    const ownText = collapse(
      Array.from(element.childNodes)
        .filter((child) => child.nodeType === 3)
        .map((child) => child.textContent ?? "")
        .join(" "),
      limits.maxTextChars
    );
    const value = safeValue(element);
    const serialized: Record<string, unknown> = {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element)
    };
    if (element.id !== "") serialized.id = collapse(element.id, 120);
    const classes = Array.from(element.classList).slice(0, limits.maxClasses);
    if (classes.length > 0) serialized.classes = classes;
    if (Object.keys(attributes).length > 0) serialized.attributes = attributes;
    if (ownText !== "") serialized.text = ownText;
    if (value !== undefined) serialized.value = value;
    if (isSensitive(element)) serialized.sensitive = true;
    const states = statesOf(element);
    if (Object.keys(states).length > 0) serialized.states = states;
    budget.chars += JSON.stringify(serialized).length;
    if (budget.chars > limits.maxChars) throw new Error("PORTAL_DOM_LIMIT_EXCEEDED");
    const children = Array.from(element.children).filter(
      (child) => !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(child.tagName)
    );
    if (children.length === 0) return serialized;
    if (depth >= limits.maxDepth) {
      serialized.truncated = { reason: "depth", children: children.length };
      return serialized;
    }
    const visible = children.slice(0, limits.maxChildren);
    serialized.children = visible.map((child) => serializeNode(child, depth + 1, budget));
    if (visible.length < children.length)
      serialized.truncated = { reason: "children", omitted: children.length - visible.length };
    return serialized;
  }

  function accessibilityNode(
    element: Element,
    depth: number,
    budget: { nodes: number }
  ): Record<string, unknown> | null {
    if (isHidden(element)) return null;
    const role = roleOf(element);
    if (role === "presentation" || role === "none") return null;
    budget.nodes += 1;
    if (budget.nodes > limits.maxNodes) throw new Error("PORTAL_DOM_LIMIT_EXCEEDED");
    const node: Record<string, unknown> = { role, name: accessibleName(element) };
    const tag = element.tagName.toLowerCase();
    if (tag !== role) node.tag = tag;
    if (element.id !== "") node.id = collapse(element.id, 120);
    const states = statesOf(element);
    if (Object.keys(states).length > 0) node.states = states;
    const value = safeValue(element);
    if (value !== undefined) node.value = value;
    if (request.includeBounds === true) node.bounds = boundsOf(element);
    if (depth < limits.maxDepth) {
      const children: Record<string, unknown>[] = [];
      for (const child of Array.from(element.children).slice(0, limits.maxChildren)) {
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(child.tagName)) continue;
        const serialized = accessibilityNode(child, depth + 1, budget);
        if (serialized !== null) children.push(serialized);
      }
      if (children.length > 0) node.children = children;
    }
    return node;
  }

  function viewport(): Record<string, unknown> {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      devicePixelRatio: window.devicePixelRatio
    };
  }

  try {
    if (request.action === "get" || request.action === "viewport") {
      const active = isElement(document.activeElement) ? document.activeElement : null;
      return {
        ok: true,
        data: {
          url: safeUrl(location.href) ?? "sobre:vazio",
          title: collapse(document.title, 512),
          readyState: document.readyState,
          viewport: viewport(),
          focused: active === null || active === document.body ? null : describe(active)
        }
      };
    }

    if (request.action === "dom") {
      let root: Element = document.body ?? document.documentElement;
      if (request.query !== undefined && request.query !== "") {
        let queried: Element | null = null;
        try {
          queried = document.querySelector(request.query);
        } catch {
          return failure("PORTAL_ELEMENT_NOT_FOUND", "Seletor inválido.", { query: request.query });
        }
        if (queried === null)
          return failure("PORTAL_ELEMENT_NOT_FOUND", "Nenhum elemento para a consulta.", {
            query: request.query
          });
        root = queried;
      }
      const budget = { nodes: 0, chars: 0 };
      const tree = serializeNode(root, 0, budget);
      return {
        ok: true,
        data: {
          url: safeUrl(location.href),
          title: collapse(document.title, 512),
          nodes: budget.nodes,
          chars: budget.chars,
          limits,
          tree
        }
      };
    }

    if (request.action === "accessibility") {
      const budget = { nodes: 0 };
      const tree = accessibilityNode(document.body ?? document.documentElement, 0, budget);
      const wantedRole = request.filter?.role?.toLowerCase();
      const wantedName = request.filter?.name;
      if (wantedRole === undefined && wantedName === undefined)
        return { ok: true, data: { nodes: budget.nodes, tree } };
      const found = candidates()
        .filter((element) => !isHidden(element))
        .filter((element) => {
          const roleOk = wantedRole === undefined || roleOf(element) === wantedRole;
          const nameOk =
            wantedName === undefined ||
            matches(accessibleName(element), wantedName, request.locator?.exact === true);
          return roleOk && nameOk;
        })
        .slice(0, limits.maxChildren)
        .map((element) => describe(element));
      return { ok: true, data: { nodes: budget.nodes, matches: found } };
    }

    if (request.action === "press") {
      const key = String(request.key ?? "");
      const allowed = [
        "Enter",
        "Escape",
        "Tab",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space"
      ];
      if (!allowed.includes(key))
        return failure("PORTAL_INVALID_KEY", "Tecla não permitida.", { key, allowed });
      let target: Element = isElement(document.activeElement)
        ? document.activeElement
        : document.body;
      if (request.locator !== undefined) {
        const located = requireElement();
        if ("ok" in located) return located;
        target = located.element;
        if (target instanceof HTMLElement) target.focus();
      }
      const modifiers = request.modifiers ?? [];
      const init: KeyboardEventInit = {
        key: key === "Space" ? " " : key,
        code: key === "Space" ? "Space" : key,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: modifiers.includes("shift"),
        ctrlKey: modifiers.includes("control"),
        altKey: modifiers.includes("alt"),
        metaKey: modifiers.includes("meta")
      };
      const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      if (key === "Enter" && down && target instanceof HTMLElement) {
        const form = target.closest("form");
        if (form !== null && target.tagName === "INPUT") form.requestSubmit();
        else if (target.tagName === "BUTTON" || target.tagName === "A") target.click();
      }
      // Synthetic KeyboardEvents also omit the browser's native focus traversal. Reproduce the
      // sequential focus order so Portal keyboard QA exercises the page instead of remaining on
      // the same element forever.
      if (key === "Tab" && down) {
        const focusable = Array.from(
          document.querySelectorAll(
            'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]'
          )
        ).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement &&
            !isHidden(element) &&
            element.getAttribute("aria-hidden") !== "true" &&
            !("disabled" in element && Boolean(element.disabled)) &&
            element.tabIndex >= 0
        );
        if (focusable.length > 0) {
          const active = isElement(document.activeElement) ? document.activeElement : target;
          const current = focusable.indexOf(active as HTMLElement);
          const backwards = modifiers.includes("shift");
          const next =
            current < 0
              ? backwards
                ? focusable.length - 1
                : 0
              : (current + (backwards ? -1 : 1) + focusable.length) % focusable.length;
          focusable[next]?.focus();
          if (isElement(document.activeElement)) target = document.activeElement;
        }
      }
      // Synthetic KeyboardEvents do not trigger the browser's native Space activation. Mirror the
      // platform's key-up behavior for buttons so Portal QA observes the same result as a real user.
      if (key === "Space" && down && target instanceof HTMLButtonElement) target.click();
      return { ok: true, data: { key, target: describe(target) } };
    }

    if (request.action === "scroll") {
      const amount = Math.max(1, Math.min(Math.round(request.amount ?? 400), 20_000));
      const direction = request.direction ?? "down";
      const top = direction === "down" ? amount : direction === "up" ? -amount : 0;
      const left = direction === "right" ? amount : direction === "left" ? -amount : 0;
      if (request.locator !== undefined) {
        const located = requireElement();
        if ("ok" in located) return located;
        located.element.scrollBy({ top, left, behavior: "auto" });
        return {
          ok: true,
          data: {
            target: describe(located.element),
            scrollTop: Math.round(located.element.scrollTop),
            scrollLeft: Math.round(located.element.scrollLeft)
          }
        };
      }
      window.scrollBy({ top, left, behavior: "auto" });
      return { ok: true, data: { target: "viewport", viewport: viewport() } };
    }

    const located = requireElement();
    if ("ok" in located) return located;
    const element = located.element;

    if (request.action === "focus") {
      if (element instanceof HTMLElement) element.focus();
      return { ok: true, data: { strategy: located.strategy, element: describe(element) } };
    }

    if (request.action === "click") {
      if (statesOf(element).disabled === true)
        return failure("PORTAL_ELEMENT_NOT_EDITABLE", "O elemento está desabilitado.", {
          element: describe(element)
        });
      element.scrollIntoView({ block: "center", inline: "center" });
      const bounds = boundsOf(element);
      const pointer = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: bounds.x + Math.round(bounds.width / 2),
        clientY: bounds.y + Math.round(bounds.height / 2)
      };
      element.dispatchEvent(new MouseEvent("mouseover", pointer));
      element.dispatchEvent(new MouseEvent("mousedown", pointer));
      if (element instanceof HTMLElement) element.focus();
      element.dispatchEvent(new MouseEvent("mouseup", pointer));
      if (element instanceof HTMLElement) element.click();
      else element.dispatchEvent(new MouseEvent("click", pointer));
      return { ok: true, data: { strategy: located.strategy, element: describe(element) } };
    }

    if (request.action === "type") {
      const editable =
        (element instanceof HTMLInputElement &&
          !["checkbox", "radio", "button", "submit", "reset", "file", "image"].includes(
            element.type
          )) ||
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLElement && element.isContentEditable);
      if (!editable)
        return failure("PORTAL_ELEMENT_NOT_EDITABLE", "O elemento não aceita digitação.", {
          element: describe(element)
        });
      const states = statesOf(element);
      if (states.disabled === true || states.readonly === true)
        return failure("PORTAL_ELEMENT_NOT_EDITABLE", "O elemento não está editável.", {
          element: describe(element)
        });
      const text = String(request.text ?? "");
      element.scrollIntoView({ block: "center" });
      if (element instanceof HTMLElement) element.focus();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const previous = request.clear === true ? "" : element.value;
        const next = `${previous}${text}`;
        const prototype =
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter !== undefined) setter.call(element, next);
        else element.value = next;
      } else if (element instanceof HTMLElement) {
        if (request.clear === true) element.textContent = "";
        element.textContent = `${element.textContent ?? ""}${text}`;
      }
      const last = text.slice(-1);
      const init: KeyboardEventInit = {
        key: last === "" ? "Unidentified" : last,
        bubbles: true,
        composed: true
      };
      element.dispatchEvent(new KeyboardEvent("keydown", init));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text }));
      element.dispatchEvent(new KeyboardEvent("keyup", init));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      const described = describe(element);
      return {
        ok: true,
        data: {
          strategy: located.strategy,
          element: described,
          length: text.length,
          /** Never echo what was typed into a sensitive field. */
          typed: isSensitive(element) ? "[oculto]" : text.slice(0, 120)
        }
      };
    }

    return failure("PORTAL_OPERATION_FAILED", "Ação de página desconhecida.", {
      action: request.action
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PORTAL_DOM_LIMIT_EXCEEDED"))
      return failure("PORTAL_DOM_LIMIT_EXCEEDED", "O resultado excede o limite seguro do DOM.", {
        limits
      });
    return failure("PORTAL_OPERATION_FAILED", "A ação falhou dentro da página.", {
      reason: message.slice(0, 240)
    });
  }
}

export function resolvePortalPageLimits(requested?: Partial<PortalPageLimits>): PortalPageLimits {
  const clamp = (key: keyof PortalPageLimits): number => {
    const value = requested?.[key];
    if (value === undefined || !Number.isFinite(value)) return defaultPortalPageLimits[key];
    return Math.min(Math.max(Math.round(value), 1), maximumPortalPageLimits[key]);
  };
  return {
    maxNodes: clamp("maxNodes"),
    maxDepth: clamp("maxDepth"),
    maxChars: clamp("maxChars"),
    maxTextChars: clamp("maxTextChars"),
    maxClasses: clamp("maxClasses"),
    maxChildren: clamp("maxChildren")
  };
}

/**
 * The page never receives interpolated code, only a JSON argument. Automation input therefore
 * cannot become script: the function body is fixed at build time and the request is data.
 */
export function buildPortalPageScript(request: PortalPageRequest): string {
  return `(${portalPageAgent.toString()})(${JSON.stringify(request)})`;
}
