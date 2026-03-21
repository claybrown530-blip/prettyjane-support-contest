const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const CLOSED_CITIES = [
  "OKC, OK",
  "Durango, CO",
  "Santa Fe, NM",
  "Spokane, WA",
  "Vancouver, BC",
  "Seattle, WA",
  "San Francisco, CA",
  "San Diego, CA",
];
const ALL_CITIES = [
  "OKC, OK",
  "Durango, CO",
  "Santa Fe, NM",
  "Spokane, WA",
  "Vancouver, BC",
  "Seattle, WA",
  "San Francisco, CA",
  "San Diego, CA",
];

function buildPayload(city) {
  return {
    city,
    voterName: "Test Voter",
    voterEmail: "testvoter@gmail.com",
    voterPhone: "555-0100",
    voterType: "individual",
    bandName: "Test Band",
  };
}

function loadVoteModuleWithMockedSupabase(createClient) {
  const votePath = require.resolve("../netlify/functions/vote.js");
  const originalLoad = Module._load;

  delete require.cache[votePath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return { createClient };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(votePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[votePath];
  }
}

function createClosedVoteSupabaseStub() {
  const inserts = [];

  return {
    inserts,
    client: {
      from(table) {
        assert.equal(table, "votes");
        return {
          async insert(rows) {
            inserts.push(...rows);
            return { error: null };
          },
        };
      },
    },
  };
}

function createOpenVoteSupabaseStub(city) {
  const insertedVotes = [];
  const roster = [{ city, name: "Approved Band" }];

  function matchesOrFilter(row, expression) {
    if (!expression) return true;
    if (expression === "is_valid_vote.is.null,is_valid_vote.eq.true") {
      return row.is_valid_vote == null || row.is_valid_vote === true;
    }
    return true;
  }

  function createQuery(table) {
    const state = {
      eqFilters: [],
      limit: null,
      or: null,
      range: null,
    };

    function execute() {
      if (table === "bands") {
        let rows = roster.slice();
        for (const [field, value] of state.eqFilters) {
          rows = rows.filter((row) => row[field] === value);
        }
        return { data: rows, error: null };
      }

      if (table === "votes") {
        let rows = insertedVotes.slice();
        for (const [field, value] of state.eqFilters) {
          rows = rows.filter((row) => row[field] === value);
        }
        rows = rows.filter((row) => matchesOrFilter(row, state.or));
        if (state.range) {
          const [from, to] = state.range;
          rows = rows.slice(from, to + 1);
        }
        if (typeof state.limit === "number") {
          rows = rows.slice(0, state.limit);
        }
        return { data: rows, error: null };
      }

      return { data: [], error: null };
    }

    const query = {
      select() {
        return query;
      },
      eq(field, value) {
        state.eqFilters.push([field, value]);
        return query;
      },
      order() {
        return query;
      },
      limit(value) {
        state.limit = value;
        return query;
      },
      range(from, to) {
        state.range = [from, to];
        return query;
      },
      or(expression) {
        state.or = expression;
        return query;
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };

    return query;
  }

  return {
    insertedVotes,
    client: {
      from(table) {
        return {
          select() {
            return createQuery(table).select();
          },
          async insert(rows) {
            insertedVotes.push(...rows);
            return { error: null };
          },
        };
      },
    },
  };
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(token));
  }

  toggle(token, force) {
    if (force === true) {
      this.values.add(token);
      return true;
    }
    if (force === false) {
      this.values.delete(token);
      return false;
    }
    if (this.values.has(token)) {
      this.values.delete(token);
      return false;
    }
    this.values.add(token);
    return true;
  }

  contains(token) {
    return this.values.has(token);
  }

  setFromString(value) {
    this.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.listeners = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this._innerHTML = "";
    this._textContent = "";
    this.value = "";
    this.disabled = false;
    this.checked = false;
    this.required = false;
    this.name = "";
    this.type = "";
    this.id = "";
    this.placeholder = "";
    this.onclick = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  dispatchEvent(event) {
    const handlers = this.listeners[event?.type] || [];
    for (const handler of handlers) {
      handler.call(this, event);
    }
    if (event?.type === "click" && typeof this.onclick === "function") {
      this.onclick.call(this, event);
    }
  }

  focus() {}

  scrollIntoView() {}

  closest(selector) {
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    let current = this.parentElement;
    while (current) {
      if (current.classList.contains(className)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const descendants = [];

    function walk(node) {
      for (const child of node.children) {
        descendants.push(child);
        walk(child);
      }
    }

    walk(this);

    if (selector === 'input[name="voterType"]:checked') {
      return descendants.filter(
        (node) => node.tagName === "INPUT" && node.name === "voterType" && node.checked
      );
    }

    if (selector === "input, button, textarea, select") {
      return descendants.filter((node) =>
        ["INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(node.tagName)
      );
    }

    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return descendants.filter((node) => node.classList.contains(className));
    }

    return [];
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (value === "") this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  get textContent() {
    return this._textContent;
  }

  set className(value) {
    this.classList.setFromString(value);
  }

  get className() {
    return Array.from(this.classList.values).join(" ");
  }
}

class FakeDocument {
  constructor() {
    this.elementsById = new Map();
    this.allElements = [];
    this.body = this.createElement("body");
  }

  createElement(tagName) {
    const element = new FakeElement(tagName, this);
    this.allElements.push(element);
    return element;
  }

  registerElement(id, tagName, parent, classes = []) {
    const element = this.createElement(tagName);
    element.id = id;
    element.classList.add(...classes);
    this.elementsById.set(id, element);
    if (parent) parent.appendChild(element);
    return element;
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelectorAll(selector) {
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.allElements.filter((node) => node.classList.contains(className));
    }
    return [];
  }
}

class FakeChart {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.data = {
      labels: [...(config?.data?.labels || [])],
      datasets: (config?.data?.datasets || []).map((dataset) => ({
        ...dataset,
        data: [...(dataset.data || [])],
      })),
    };
    FakeChart.instances.push(this);
  }

  update() {}
}

FakeChart.instances = [];

function createFrontendHarness() {
  const document = new FakeDocument();
  const voteCard = document.registerElement("voteCard", "section", document.body);
  const form = document.registerElement("voteForm", "form", voteCard);
  const toast = document.registerElement("toast", "div", voteCard, ["hidden"]);
  const cityClosedMsg = document.registerElement("cityClosedMsg", "div", voteCard, ["hidden"]);
  const bandEmailWrap = document.registerElement("bandEmailWrap", "label", form, ["hidden"]);
  const citySelect = document.registerElement("citySelect", "select", form);
  const okcBandPicker = document.registerElement("okcBandPicker", "div", form, ["hidden"]);
  const okcBandButtons = document.registerElement("okcBandButtons", "div", okcBandPicker);
  const bandNameWrap = document.registerElement("bandNameWrap", "label", form);
  const bandNameInput = document.registerElement("bandName", "input", bandNameWrap);
  const loadState = document.registerElement("loadState", "span", document.body);
  const citySelectBoard = document.registerElement("citySelectBoard", "select", document.body);
  const topList = document.registerElement("topList", "div", document.body);
  const chart = document.registerElement("chart", "canvas", document.body);
  const seedSection = document.createElement("div");
  seedSection.classList.add("seedSection");
  document.body.appendChild(seedSection);
  const seedList = document.registerElement("seedList", "div", seedSection);

  const voterNameInput = document.createElement("input");
  voterNameInput.name = "voterName";
  form.appendChild(voterNameInput);

  const voterEmailInput = document.createElement("input");
  voterEmailInput.name = "voterEmail";
  voterEmailInput.type = "email";
  form.appendChild(voterEmailInput);

  const individualRadio = document.createElement("input");
  individualRadio.name = "voterType";
  individualRadio.type = "radio";
  individualRadio.value = "individual";
  individualRadio.checked = true;
  form.appendChild(individualRadio);

  const bandRadio = document.createElement("input");
  bandRadio.name = "voterType";
  bandRadio.type = "radio";
  bandRadio.value = "band";
  form.appendChild(bandRadio);

  const bandContactEmailInput = document.createElement("input");
  bandContactEmailInput.name = "bandContactEmail";
  bandContactEmailInput.type = "email";
  bandEmailWrap.appendChild(bandContactEmailInput);

  const referralCodeInput = document.createElement("input");
  referralCodeInput.name = "referralCode";
  form.appendChild(referralCodeInput);

  bandNameInput.name = "bandName";
  bandNameInput.required = true;

  const voterPhoneInput = document.createElement("input");
  voterPhoneInput.name = "voterPhone";
  form.appendChild(voterPhoneInput);

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  form.appendChild(submitButton);

  const snapshots = Object.fromEntries(
    ALL_CITIES.map((city) => {
      const bandName = `${city} Leader`;
      return [
        city,
        {
          ok: true,
          city,
          seeds: [{ name: bandName }],
          totals: { [bandName]: 10 },
          threshold: 10,
          writeInVisibilityThreshold: 5,
        },
      ];
    })
  );

  const fetch = async (url) => {
    const city = new URL(url, "https://example.com").searchParams.get("city");
    return {
      ok: true,
      async json() {
        return snapshots[city];
      },
    };
  };

  const window = {
    location: {
      href: "https://example.com/",
      search: "",
    },
    history: {
      replaceState() {},
    },
  };

  const context = vm.createContext({
    window,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    fetch,
    Chart: FakeChart,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  });

  window.document = document;
  window.navigator = context.navigator;
  window.URL = URL;
  window.URLSearchParams = URLSearchParams;
  window.fetch = fetch;
  window.Chart = FakeChart;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.console = console;

  return {
    context,
    document,
    elements: {
      bandNameInput,
      bandNameWrap,
      cityClosedMsg,
      citySelect,
      citySelectBoard,
      form,
      loadState,
      okcBandPicker,
      submitButton,
      topList,
    },
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("backend rejects submissions for every closed city", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

  for (const city of CLOSED_CITIES) {
    await t.test(city, async () => {
      const supabaseStub = createClosedVoteSupabaseStub();
      const { handler } = loadVoteModuleWithMockedSupabase(() => supabaseStub.client);
      const response = await handler({
        httpMethod: "POST",
        body: JSON.stringify(buildPayload(city)),
      });
      const body = JSON.parse(response.body);

      assert.equal(response.statusCode, 400);
      assert.match(body.error, /closed/i);
      assert.equal(supabaseStub.inserts.length, 1);
      assert.equal(supabaseStub.inserts[0].city, city);
      assert.equal(supabaseStub.inserts[0].invalid_reason, "city_closed");
      assert.equal(supabaseStub.inserts[0].is_valid_vote, false);
    });
  }
});

test("frontend shows closed state for every closed city while still rendering the leaderboard", async (t) => {
  FakeChart.instances.length = 0;
  const harness = createFrontendHarness();
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  vm.runInContext(appSource, harness.context, { filename: "app.js" });
  assert.equal(typeof harness.context.setCity, "function");

  for (const city of CLOSED_CITIES) {
    await t.test(city, async () => {
      harness.context.setCity(city);
      await flushAsyncWork();

      assert.equal(harness.elements.citySelect.value, city);
      assert.equal(harness.elements.citySelectBoard.value, city);
      assert.equal(harness.elements.cityClosedMsg.classList.contains("hidden"), false);
      assert.match(harness.elements.cityClosedMsg.textContent, /Voting is closed/);
      assert.equal(harness.elements.bandNameWrap.classList.contains("hidden"), true);
      assert.equal(harness.elements.bandNameInput.disabled, true);
      assert.equal(harness.elements.submitButton.disabled, true);
      assert.ok(harness.elements.bandNameInput.placeholder.includes("Voting is closed"));
      assert.equal(harness.elements.okcBandPicker.classList.contains("hidden"), true);
      assert.equal(harness.elements.topList.children.length, 1);
      assert.match(harness.elements.topList.children[0].innerHTML, /Leader/);
      assert.ok(FakeChart.instances[0].data.labels.length >= 1);
    });
  }
});
