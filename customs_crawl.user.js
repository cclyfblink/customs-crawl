// ==UserScript==
// @name         Customs Crawl Standalone Helper
// @namespace    https://github.com/Smart-Trans-Organization/customs-crawl
// @version      0.1.0
// @description  Run standalone China Customs queries through a local coordinator.
// @match        http://stats.customs.gov.cn/queryData/queryDataByWhere*
// @match        http://stats.customs.gov.cn/queryData/queryDataList*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const hashOptions = new URLSearchParams(location.hash.replace(/^#/, ""));
  const coordinatorPort = hashOptions.get("customs-crawl-port") || "8765";
  const coordinatorHash = `#customs-crawl-port=${coordinatorPort}`;
  const COORDINATOR_URL = `http://127.0.0.1:${coordinatorPort}`;
  const CLIENT_ID_KEY = "customs-crawl-client-id";
  const CLIENT_ID = GM_getValue(CLIENT_ID_KEY)
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  GM_setValue(CLIENT_ID_KEY, CLIENT_ID);
  const IS_QUERY_PAGE = location.pathname.includes("/queryData/queryDataByWhere");
  const IS_RESULT_PAGE = location.pathname.includes("/queryData/queryDataList");

  const GROUP_LABELS = {
    CODE_TS: "商品",
    ORIGIN_COUNTRY: "贸易伙伴",
    TRADE_MODE: "贸易方式",
    TRADE_CO_PORT: "收发货人注册地",
  };

  const GROUP_FIELDS = {
    commodity: "CODE_TS",
    partner: "ORIGIN_COUNTRY",
    trade_mode: "TRADE_MODE",
    province: "TRADE_CO_PORT",
  };

  let batchRunning = false;
  let batchPaused = false;

  function setStatus(message, state = "idle") {
    const status = document.querySelector("#customs-crawl-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  }

  function setPlan(plan) {
    const element = document.querySelector("#customs-crawl-plan");
    if (!element || !plan.jobs?.length) return;
    const jobs = plan.jobs;
    const codes = [...new Set(jobs.map((job) => job.code))];
    const years = jobs.map((job) => job.year);
    const tradeTypes = [...new Set(jobs.map((job) => job.ie_type))].map((value) => ({
      export: "出口",
      import: "进口",
      "import-export": "进出口",
    })[value] || value);
    const currencies = [...new Set(jobs.map((job) => job.currency.toUpperCase()))];
    const groups = [...new Set(jobs.flatMap((job) => job.groups))].map((value) => ({
      commodity: "商品",
      partner: "贸易伙伴",
      trade_mode: "贸易方式",
      province: "收发货人注册地",
    })[value] || value);
    element.textContent = [
      `配置：${codes.join("、")}`,
      `${Math.min(...years)}-${Math.max(...years)}`,
      `${jobs.length} 个期间任务`,
      tradeTypes.join("/"),
      currencies.join("/"),
      groups.join("、"),
    ].join("；");
  }

  function setSelect(select, value) {
    select.value = String(value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function ensureMonthOption(select, month) {
    const value = String(month);
    if (Array.from(select.options).some((option) => option.value === value)) return;
    select.add(new Option(value, value));
  }

  async function fillQuery(query) {
    const year = document.querySelector("#year");
    const startMonth = document.querySelector("#startMonth");
    const endMonth = document.querySelector("#endMonth");
    const searchButton = document.querySelector("#doSearch");

    if (!year || !startMonth || !endMonth || !searchButton) {
      throw new Error("查询表单尚未加载完成。");
    }

    document.querySelector(`input[name="iEType"][value="${query.ieType}"]`).checked = true;
    document.querySelector(`input[name="currencyType"][value="${query.currency}"]`).checked = true;

    // Past years always have twelve completed months. Adding missing options avoids
    // the protected getMonth request that currently returns HTTP 400 under automation.
    setSelect(year, query.year);
    await sleep(800);
    ensureMonthOption(startMonth, query.startMonth);
    ensureMonthOption(endMonth, query.endMonth);
    setSelect(startMonth, query.startMonth);
    setSelect(endMonth, query.endMonth);

    const monthFlag = document.querySelector('input[name="monthFlag"], #monthFlag');
    monthFlag.checked = true;
    monthFlag.dispatchEvent(new Event("input", { bubbles: true }));
    monthFlag.dispatchEvent(new Event("change", { bubbles: true }));

    for (let index = 1; index <= 4; index += 1) {
      const configuredGroup = query.groups[index - 1] || "";
      const field = GROUP_FIELDS[configuredGroup] || configuredGroup;
      const fieldSelect = document.querySelector(`#outerField${index}`);
      const fieldValue = document.querySelector(`#outerValue${index}`);
      setSelect(fieldSelect, field);
      fieldValue.value = field === "CODE_TS" ? query.code : "";
      fieldValue.dispatchEvent(new Event("input", { bubbles: true }));
      fieldValue.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const form = document.querySelector("#Search_form");
    const params = new FormData(form);
    if (params.get("outerField1") !== "CODE_TS" || params.get("outerValue1") !== query.code) {
      throw new Error("商品代码未正确写入查询表单。");
    }
    if (
      params.get("year") !== String(query.year)
      || params.get("startMonth") !== String(query.startMonth)
      || params.get("endMonth") !== String(query.endMonth)
      || !params.has("monthFlag")
    ) {
      throw new Error("年度范围或分月展示未正确写入查询表单。");
    }

    setStatus("查询条件已填写，正在提交。", "pending");
    searchButton.click();
  }

  function coordinatorRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${COORDINATOR_URL}${path}`,
        data,
        headers,
        responseType: "arraybuffer",
        timeout: 15000,
        onload(response) {
          const text = new TextDecoder().decode(response.response);
          if (response.status < 200 || response.status >= 300) {
            let detail = text;
            try {
              detail = JSON.parse(text).error || text;
            } catch (_error) {
              // Keep the response body when it is not JSON.
            }
            reject(new Error(`本地协调服务返回 ${response.status}：${detail}`));
            return;
          }
          resolve(text ? JSON.parse(text) : {});
        },
        ontimeout() {
          reject(new Error("连接本地协调服务超时。"));
        },
        onerror() {
          reject(new Error("无法连接本地协调服务。"));
        },
      });
    });
  }

  async function waitFor(check, timeoutMilliseconds, intervalMilliseconds = 250) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(intervalMilliseconds);
    }
    return null;
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function findTransparentTarget(canvas) {
    const context = canvas.getContext("2d");
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha >= 80) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        area += 1;
      }
    }

    if (maxX < minX || maxY < minY || maxX - minX < 20 || maxY - minY < 20 || area < 200) {
      throw new Error("未识别到验证码背景中的透明目标区域。");
    }

    return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, area };
  }

  function dispatchMouse(target, type, x, y, buttons) {
    const view = target.ownerDocument?.defaultView || target.defaultView;
    target.dispatchEvent(new view.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons,
    }));
  }

  async function moveSyntheticHumanLike(captchaDocument, fromX, toX, baseY) {
    const distance = toX - fromX;
    const steps = Math.max(3, Math.min(8, Math.ceil(Math.abs(distance) / 10)));
    const wobble = 0.8 + Math.random() * 1.8;

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const eased = 1 - Math.pow(1 - progress, 2);
      const x = fromX + distance * eased + (Math.random() - 0.5) * 0.8;
      const y = baseY
        + Math.sin(progress * Math.PI * (1.1 + Math.random() * 0.4)) * wobble
        + (Math.random() - 0.5) * 0.6;
      dispatchMouse(captchaDocument, "mousemove", x, y, 1);
      await sleep(14 + Math.random() * 24);
    }
  }

  async function syntheticDrag(frame) {
    const captchaDocument = frame.contentDocument;
    const canvases = Array.from(captchaDocument.querySelectorAll("canvas"));
    const slider = captchaDocument.querySelector(".sliderIcon");
    if (canvases.length < 2 || !slider) {
      throw new Error("验证码 Canvas 或滑块不存在。");
    }

    const background = canvases[0];
    const foreground = canvases[1];
    const target = findTransparentTarget(background);
    const backgroundRect = background.getBoundingClientRect();
    const sliderRect = slider.getBoundingClientRect();
    const targetLeft = target.left * (backgroundRect.width / background.width);
    const startX = sliderRect.left + sliderRect.width / 2;
    const startY = sliderRect.top + sliderRect.height / 2;
    const initialForegroundLeft = foreground.getBoundingClientRect().left - backgroundRect.left;

    dispatchMouse(slider, "mousedown", startX, startY, 1);
    await sleep(110 + Math.random() * 70);

    let mouseX = startX;
    let movementRatio = 1;
    const trace = [];

    for (let iteration = 0; iteration < 14; iteration += 1) {
      const foregroundLeft = foreground.getBoundingClientRect().left - backgroundRect.left;
      const remaining = targetLeft - foregroundLeft;
      trace.push({ iteration, mouseX, foregroundLeft, remaining, movementRatio });
      if (Math.abs(remaining) <= 0.8) break;

      const movement = Math.max(-45, Math.min(55, remaining / Math.max(movementRatio, 0.2)));
      const nextMouseX = mouseX + movement;
      await moveSyntheticHumanLike(captchaDocument, mouseX, nextMouseX, startY);
      mouseX = nextMouseX;
      await sleep(35 + Math.random() * 55);

      const nextForegroundLeft = foreground.getBoundingClientRect().left - backgroundRect.left;
      const foregroundMovement = nextForegroundLeft - foregroundLeft;
      if (Math.abs(movement) > 0.5 && foregroundMovement / movement > 0.05) {
        movementRatio = movementRatio * 0.55 + (foregroundMovement / movement) * 0.45;
      }
    }

    const foregroundLeftBeforeDrop = foreground.getBoundingClientRect().left - backgroundRect.left;
    await moveSyntheticHumanLike(captchaDocument, mouseX, mouseX + (Math.random() - 0.5) * 1.6, startY);
    await sleep(80 + Math.random() * 80);
    dispatchMouse(captchaDocument, "mouseup", mouseX, startY, 0);
    await sleep(2200);

    const text = captchaDocument.body?.innerText || "";
    const passed = text.includes("验证通过");
    return {
      passed,
      target,
      targetLeft,
      initialForegroundLeft,
      foregroundLeftBeforeDrop,
      errorBeforeDrop: foregroundLeftBeforeDrop - targetLeft,
      movementRatio,
      trace,
      finalText: text.trim(),
    };
  }

  async function acceptLongRangePrompt() {
    const confirm = await waitFor(() => {
      const candidates = Array.from(document.querySelectorAll("a.layui-layer-btn0"));
      return candidates.find((element) => isVisible(element)) || null;
    }, 8000);
    if (confirm) confirm.click();
  }

  async function waitForCaptchaFrame() {
    return await waitFor(() => {
      const frame = document.querySelector('iframe[src*="/queryData/toCaptchaView"]');
      return frame && isVisible(frame) ? frame : null;
    }, 20000, 300);
  }

  async function waitForCaptchaReady(frame) {
    return Boolean(await waitFor(() => {
      const captchaDocument = frame.contentDocument;
      const text = captchaDocument?.body?.innerText || "";
      return captchaDocument?.querySelectorAll("canvas").length >= 2
        && captchaDocument.querySelector(".sliderIcon")
        && (text.includes("拼图验证") || text.includes("向右滑动模块填充拼图"));
    }, 15000, 300));
  }

  function clickCaptchaConfirm(frame) {
    const captchaDocument = frame.contentDocument;
    const candidates = Array.from(captchaDocument.querySelectorAll("a,button,input[type='button'],input[type='submit']"));
    const confirm = candidates.find((element) => {
      const text = (element.innerText || element.value || "").trim();
      const style = frame.contentWindow.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return text === "确定" && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    });
    if (!confirm) throw new Error("验证码通过后未找到确定按钮。");
    confirm.click();
  }

  async function solveCaptcha(frame) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!await waitForCaptchaReady(frame)) {
        throw new Error("验证码图片或滑块未加载。");
      }
      setStatus(`正在识别并拖动验证码（${attempt}/3）。`, "pending");
      const result = await syntheticDrag(frame);
      console.info("[RETracker customs] captcha result", result);
      if (result.passed) {
        clickCaptchaConfirm(frame);
        return;
      }
      await sleep(1500);
    }
    throw new Error("验证码连续三次未通过。");
  }

  async function waitForResultFrame() {
    return await waitFor(() => {
      const frame = document.querySelector('iframe[src*="/queryData/queryDataList"]');
      return frame?.contentDocument?.querySelector("#table") ? frame : null;
    }, 30000, 400);
  }

  async function waitForResultRows(frame) {
    const ready = await waitFor(() => {
      const resultDocument = frame.contentDocument;
      const text = resultDocument?.body?.innerText || "";
      const rows = resultDocument?.querySelectorAll("#div1 tr, #div2 tr").length || 0;
      const totalSize = resultDocument?.querySelector("#totalSize")?.value || "";
      const total = Number(totalSize.replace(/[^\d]/g, ""));
      const loading = resultDocument?.querySelector("#test");
      const loadingVisible = loading && frame.contentWindow.getComputedStyle(loading).display !== "none";
      if (rows === 0 && total > 0 && typeof frame.contentWindow.queryData === "function") {
        frame.contentWindow.queryData(1);
      }
      return rows > 0 || (total > 0 && !loadingVisible) || (!loadingVisible && hasNoDataText(text));
    }, 60000, 600);
    if (!ready) throw new Error("结果数据在 60 秒内未完成加载。");
  }

  function hasNoDataText(text) {
    return text.includes("暂无数据") || /共查询到\s*0\s*条数据/.test(text);
  }

  function resultDownloadParameters(frame) {
    const resultDocument = frame.contentDocument;
    const get = (selector) => resultDocument.querySelector(selector)?.value || "";
    const totalSize = get("#totalSize");
    const total = Number(totalSize.replace(/[^\d]/g, ""));
    if (!total) throw new Error("查询结果没有可导出的数据行。");
    if (resultDocument.querySelector("#hidPageSize")) {
      resultDocument.querySelector("#hidPageSize").value = String(total);
    }
    return {
      totalSize,
      pageSize: get("#hidPageSize"),
      iEType: get("#iEType"),
      currencyType: get("#currencyType"),
      year: get("#year"),
      startMonth: get("#startMonth"),
      endMonth: get("#endMonth"),
      monthFlag: get("#monthFlag"),
      unitFlag: get("#unitFlag"),
      unitFlag1: get("#unitFlag1"),
      codeLength: get("#codeLength"),
      outerField1: get("#outerField1"),
      outerField2: get("#outerField2"),
      outerField3: get("#outerField3"),
      outerField4: get("#outerField4"),
      outerValue1: get("#outerValue1"),
      outerValue2: get("#outerValue2"),
      outerValue3: get("#outerValue3"),
      outerValue4: get("#outerValue4"),
      orderType: get("#orderType"),
      selectTableState: get("#selectTableState"),
      currentStartTime: get("#currentStartTime"),
    };
  }

  function resultHasNoData(frame) {
    const resultDocument = frame.contentDocument;
    const totalSize = resultDocument.querySelector("#totalSize")?.value || "";
    const total = Number(totalSize.replace(/[^\d]/g, ""));
    return total === 0 && hasNoDataText(resultDocument.body?.innerText || "");
  }

  async function fetchOfficialCsv(frame) {
    const parameters = resultDownloadParameters(frame);
    const response = await frame.contentWindow.fetch("/queryData/downloadQueryData", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams(parameters).toString(),
    });
    if (!response.ok) throw new Error(`官网导出接口返回 HTTP ${response.status}。`);
    const payload = await response.arrayBuffer();
    if (payload.byteLength < 20) throw new Error("官网导出接口返回空文件。");
    return payload;
  }

  function closeLayers() {
    const closeButtons = Array.from(document.querySelectorAll(".layui-layer-close"));
    for (const button of closeButtons.reverse()) {
      if (isVisible(button)) button.click();
    }
  }

  async function executeQueryJob(job) {
    const period = `${job.year} 年 ${job.start_month}-${job.end_month} 月`;
    setStatus(`正在查询 ${job.code}，${period}。`, "pending");
    await fillQuery({
      code: job.code,
      year: job.year,
      startMonth: job.start_month,
      endMonth: job.end_month,
      ieType: job.ie_type_value,
      currency: job.currency,
      groups: job.groups,
    });
    await acceptLongRangePrompt();
    const captchaFrame = await waitForCaptchaFrame();
    if (!captchaFrame) throw new Error("查询后未出现验证码窗口。");
    await solveCaptcha(captchaFrame);
    setStatus("验证码已通过，正在进入结果页。", "pending");
    await sleep(30000);
    throw new Error("验证码通过后页面未进入结果页。");
  }

  async function returnToSettings() {
    const candidates = Array.from(document.querySelectorAll("a,button,input[type='button'],span"));
    const back = candidates.find((element) => {
      const text = (element.innerText || element.value || "").trim();
      return text === "返回设置" && isVisible(element);
    });
    if (back) back.click();
    await sleep(1500);
    if (IS_RESULT_PAGE) {
      location.href = `/queryData/queryDataByWhere${coordinatorHash}`;
    }
    await sleep(30000);
  }

  async function executeResultJob(job) {
    const resultPage = { contentDocument: document, contentWindow: window };
    const period = `${job.year} 年 ${job.start_month}-${job.end_month} 月`;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      setStatus(`正在读取 ${job.code} ${period} 结果（${attempt}/6）。`, "pending");
      await waitForResultRows(resultPage);
      if (resultHasNoData(resultPage)) {
        await coordinatorRequest("POST", `/api/no-data/${job.job_id}`, new ArrayBuffer(0));
        setStatus(`${job.code} ${period} 查询完成，无数据。`, "success");
        await returnToSettings();
        return;
      }
      const payload = await fetchOfficialCsv(resultPage);
      try {
        const saved = await coordinatorRequest(
          "POST",
          `/api/result/${job.job_id}`,
          payload,
          { "Content-Type": "text/csv" }
        );
        setStatus(`已保存 ${saved.saved}。`, "success");
        await returnToSettings();
        return;
      } catch (error) {
        const staleResult = error.message.includes("outside the query range");
        if (!staleResult || attempt === 6) throw error;
        setStatus(`结果页仍是上一期间数据，5 秒后重试（${attempt}/6）。`, "pending");
        await sleep(5000);
      }
    }
  }

  async function runBatch() {
    if (batchRunning) return;
    batchPaused = false;
    batchRunning = true;
    const startButton = document.querySelector("#customs-crawl-start");
    const pauseButton = document.querySelector("#customs-crawl-pause");
    if (startButton) startButton.disabled = true;
    if (pauseButton) pauseButton.disabled = false;

    let response;
    try {
      response = await coordinatorRequest("GET", `/api/next?client=${encodeURIComponent(CLIENT_ID)}`);
    } catch (error) {
      setStatus(error.message, "error");
      batchRunning = false;
      return;
    }

    if (response.state === "wait") {
      setStatus("另一个海关查询页面正在执行任务。", "pending");
      batchRunning = false;
      return;
    }
    if (response.state === "done") {
      const summary = response.summary;
      setStatus(`批处理完成：成功 ${summary.completed}，失败 ${summary.failed}。`, summary.failed ? "error" : "success");
      batchRunning = false;
      return;
    }

    const job = response.job;
    try {
      if (IS_RESULT_PAGE) {
        await executeResultJob(job);
      } else if (IS_QUERY_PAGE) {
        await executeQueryJob(job);
      }
    } catch (error) {
      console.error("[RETracker customs] batch job failed", job, error);
      await coordinatorRequest(
        "POST",
        `/api/fail/${job.job_id}`,
        JSON.stringify({ error: error.message }),
        { "Content-Type": "application/json" }
      ).catch(() => {});
      closeLayers();
      setStatus(`${job.code} ${job.year} 年失败：${error.message}`, "error");
      if (IS_RESULT_PAGE) await returnToSettings();
    }
    batchRunning = false;
    if (startButton) startButton.disabled = false;
    if (pauseButton) pauseButton.disabled = true;
  }

  function addControl() {
    if (document.querySelector("#customs-crawl-panel")) return;

    const panel = document.createElement("div");
    panel.id = "customs-crawl-panel";
    panel.innerHTML = `
      <button id="customs-crawl-start" type="button">开始批量</button>
      <button id="customs-crawl-pause" type="button" disabled>暂停</button>
      <div id="customs-crawl-text">
        <span id="customs-crawl-plan">等待独立抓取配置</span>
        <span id="customs-crawl-status">等待批量任务</span>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement("style");
    style.textContent = `
      #customs-crawl-panel {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid #b8c6d6;
        background: #fff;
        color: #263648;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        font: 14px/1.4 "Microsoft YaHei", sans-serif;
      }
      #customs-crawl-start,
      #customs-crawl-pause {
        border: 1px solid #1d5f93;
        padding: 6px 14px;
        background: #1d5f93;
        color: #fff;
        cursor: pointer;
      }
      #customs-crawl-start:hover,
      #customs-crawl-pause:hover { background: #174d77; }
      #customs-crawl-start:disabled,
      #customs-crawl-pause:disabled {
        border-color: #aeb8c2;
        background: #d8dde2;
        color: #66727d;
        cursor: default;
      }
      #customs-crawl-text { display: grid; gap: 2px; }
      #customs-crawl-plan { color: #263648; }
      #customs-crawl-status[data-state="pending"] { color: #8a5a00; }
      #customs-crawl-status[data-state="success"] { color: #176b3a; }
      #customs-crawl-status[data-state="error"] { color: #a12622; }
    `;
    document.head.appendChild(style);

    document.querySelector("#customs-crawl-start").addEventListener("click", runBatch);
    document.querySelector("#customs-crawl-pause").addEventListener("click", () => {
      batchPaused = true;
      batchRunning = false;
      setStatus("将在当前任务结束后暂停。", "pending");
    });
  }

  async function autoStartBatch() {
    if (batchRunning || batchPaused) return;
    try {
      const plan = await coordinatorRequest("GET", "/api/plan");
      setPlan(plan);
      const summary = plan.summary;
      if (summary.pending > 0 || summary.running > 0) {
        runBatch();
      }
    } catch (_error) {
      // The coordinator is only available while a customs batch command is running.
    }
  }

  addControl();
  window.setInterval(autoStartBatch, 2000);
  autoStartBatch();
})();
