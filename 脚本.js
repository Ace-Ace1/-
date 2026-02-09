// ==UserScript==
// @name         近30天商品访客数/加购件数/支付金额+近3个月订单自动获取    --Ace
// @namespace    http://tampermonkey.net/
// @version      23.6
// @description  悬浮球唤出调试框，可配置并发数量/间隔，风控识别
// @author       zzy（优化版）
// @match        https://myseller.taobao.com/home.htm/SellManage/*
// @match        https://myseller.taobao.com/home.htm*
// @grant        GM_xmlhttpRequest
// @connect      sycm.taobao.com
// @connect      trade.taobao.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ===================== 全局配置变量（可根据需要调整） =====================
  // 接口token（默认值，可根据实际情况修改）
  const globalToken = "ab69f1ffc";
  // 最大并发请求数（默认1，范围1-20）
  let globalMaxConcurrent = 1;
  // 请求间隔（毫秒，默认500，最小100）
  let globalRequestInterval = 1000;
  // cookie2值（需要手动填写）
  let globalCookie2 = "";

  // ===================== 全局状态变量 =====================
  // 调试框是否已创建
  let debugBoxCreated = false;
  // 调试框是否可见
  let debugBoxVisible = false;
  // 调试框滚动位置
  let debugBoxScrollTop = 0;
  // 请求结果列表
  let requestResults = [];
  // 已请求过的商品ID列表
  let requestedProductIds = [];
  // 批量请求是否正在运行
  let batchRequestRunning = true; // 初始为true，避免初始化触发
  // 折叠状态（默认收起：ids=true、results=true、resultsSuccess/resultsFailed 分开）
  let foldState = {
    ids: true,
    results: true,
    resultsSuccess: true,  // 📡 请求成功结果
    resultsFailed: true,   // 📡 请求失败结果
  };
  // 并发请求状态统计
  let concurrentStatus = {
    total: 0, // 总请求数
    completed: 0, // 已完成数
    success: 0, // 成功数
    failed: 0, // 失败数
  };
  // cookie输入框是否聚焦
  let cookieInputFocused = false;
  // 重新请求按钮冷却结束时间戳（0 表示未在冷却）
  let retryButtonCooldownUntil = 0;
  let retryButtonCooldownTimer = null;
  // 是否触发风控限制（展示用：任一接口被限制即 true）
  let isRateLimited = false;
  // 分接口风控：Sycm（商品访客/加购/支付）与 Trade（actualFee）独立，一个被限制不影响另一个继续请求
  let isRateLimitedSycm = false;
  let isRateLimitedTrade = false;

  // ===================== 工具函数 =====================
  /**
   * 更新全局风控展示状态（根据 Sycm/Trade 两个标志计算）
   */
  function updateRateLimitDisplay() {
    isRateLimited = isRateLimitedSycm || isRateLimitedTrade;
  }

  /**
   * 延迟函数（控制请求间隔）
   * @param {number} ms 延迟毫秒数
   * @returns {Promise} 延迟Promise
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 检测响应数据是否是风控限制返回
   * @param {string} responseText 接口响应文本
   * @param {string} [source] 来源：'sycm' 为商品指标接口，'trade' 为 actualFee 接口；只标记对应接口，另一接口继续正常请求
   * @returns {boolean} 是否是风控数据
   */
  function isRateLimitData(responseText, source) {
    try {
      // 首先检测特定的错误信息 "SM::哎哟喂,被挤爆啦,请稍后重试"
      if (responseText.includes("SM::哎哟喂,被挤爆啦,请稍后重试") || responseText.includes("被挤爆啦")) {
        if (source === "trade") isRateLimitedTrade = true;
        else isRateLimitedSycm = true;
        updateRateLimitDisplay();
        return true;
      }

      // 然后检测传统的风控格式
      const responseData = JSON.parse(responseText);
      // 风控特征：包含rgv587_flag=sm 且 url包含bixi.alicdn.com/punish
      if (
        responseData.rgv587_flag === "sm" &&
        responseData.url &&
        responseData.url.includes("bixi.alicdn.com/punish")
      ) {
        if (source === "trade") isRateLimitedTrade = true;
        else isRateLimitedSycm = true;
        updateRateLimitDisplay();
        return true;
      }
      return false;
    } catch (error) {
      // 即使JSON解析失败，也检查字符串中是否包含特定错误信息
      if (responseText.includes("SM::哎哟喂,被挤爆啦,请稍后重试") || responseText.includes("被挤爆啦")) {
        if (source === "trade") isRateLimitedTrade = true;
        else isRateLimitedSycm = true;
        updateRateLimitDisplay();
        return true;
      }
      return false; // 非JSON格式且不包含特定错误信息
    }
  }

  /**
   * 数字格式化：保留两位小数，无数据返回"暂无数据"
   * @param {number|string} num 要格式化的数字
   * @returns {string} 格式化结果
   */
  function formatNumber(num) {
    if (num === null || num === undefined || num === "") return "暂无数据";
    const number = parseFloat(num);
    if (isNaN(number)) return "暂无数据";
    return number.toFixed(2);
  }

  /**
   * 校验并修正并发数和请求间隔
   */
  function validateRequestParams() {
    // 修正并发数：确保是1-20之间的整数
    globalMaxConcurrent = parseInt(globalMaxConcurrent) || 1;
    if (globalMaxConcurrent < 1) globalMaxConcurrent = 1;
    if (globalMaxConcurrent > 20) globalMaxConcurrent = 20;

    // 修正请求间隔：确保是>=100的整数
    globalRequestInterval = parseInt(globalRequestInterval) || 500;
    if (globalRequestInterval < 100) globalRequestInterval = 500;
  }

  /**
   * 获取当前时间戳
   * @returns {number} 毫秒级时间戳
   */
  function getTimestamp() {
    return Date.now();
  }

  /** 判断是否为需要重试的失败（风控/错误等，非“暂无数据”） */
  function isRetryableFailure(msg) {
    if (typeof msg !== "string") return false;
    return (
      msg.includes("RGV587_ERROR") ||
      msg.includes("被挤爆啦") ||
      msg.includes("请求被限制") ||
      msg.includes("请求太频繁被限制") ||
      msg.includes("cookie2未填写") ||
      msg.includes("产品ID为空")
    );
  }

  /**
   * 获取主请求（Sycm 商品指标）失败、需要整单重试的商品ID
   * @returns {array}
   */
  function getFailedMainRequestIds() {
    return requestResults
      .filter(
        (item) =>
          item &&
          item.payAmt &&
          item.payAmt.success === false &&
          isRetryableFailure(item.payAmt.msg)
      )
      .map((item) => item.productId);
  }

  /**
   * 获取 actualFee 失败的商品ID
   * @returns {array} 未成功请求 actualFee 的商品ID列表
   */
  function getFailedActualFeeIds() {
    return requestResults
      .filter(
        (item) =>
          item &&
          item.actualFee &&
          item.actualFee.success === false &&
          isRetryableFailure(item.actualFee.msg)
      )
      .map((item) => item.productId);
  }

  /**
   * 获取近30天的日期范围（格式：开始日期|结束日期）
   * @returns {string} 日期范围字符串
   */
  function getDateRange() {
    try {
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(today.getDate() - 1); // 结束日期：昨天
      const startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 29); // 开始日期：30天前

      // 日期格式化：yyyy-mm-dd
      const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      };

      return `${formatDate(startDate)}|${formatDate(endDate)}`;
    } catch (error) {
      console.warn("日期范围生成失败：", error);
      return "";
    }
  }

  /**
   * 提取页面中的关键Cookie（_m_h5_tk、_m_h5_tk_enc）
   * @returns {object} Cookie键值对
   */
  function extractCookies() {
    try {
      const targetCookies = ["_m_h5_tk_enc", "_m_h5_tk"];
      const cookieResult = {};
      const cookieMap = {};

      // 解析所有Cookie
      document.cookie.split(/;\s*/).forEach((cookie) => {
        const equalIndex = cookie.indexOf("=");
        if (equalIndex === -1) return;
        const key = cookie.substring(0, equalIndex).trim();
        const value = cookie.substring(equalIndex + 1).trim();
        cookieMap[key] = value;
      });

      // 提取目标Cookie
      targetCookies.forEach((key) => {
        cookieResult[key] = cookieMap[key] || "未找到该Cookie";
      });

      // 检查_m_h5_tk格式是否正常
      if (
        cookieResult._m_h5_tk &&
        cookieResult._m_h5_tk !== "未找到该Cookie" &&
        !cookieResult._m_h5_tk.includes("&")
      ) {
        cookieResult._m_h5_tk = `[格式异常]${cookieResult._m_h5_tk}`;
      }

      return cookieResult;
    } catch (error) {
      console.warn("Cookie提取失败：", error);
      return {
        _m_h5_tk_enc: "提取失败",
        _m_h5_tk: "提取失败",
      };
    }
  }

  /**
   * 从页面提取商品ID列表
   * @returns {object} {ids: 商品ID数组, msg: 提示信息}
   */
  function extractProductIds() {
    try {
      const productElements = document.querySelectorAll(".product-desc-span");
      const productIds = [];

      if (productElements.length === 0) {
        return { ids: [], msg: "未找到product-desc-span元素" };
      }

      // 遍历元素提取ID
      productElements.forEach((element) => {
        const text = element.textContent?.trim() || "";
        const idMatch = text.match(/ID[:：]\s*(.+)/);
        if (idMatch && idMatch[1]) {
          const productId = idMatch[1].trim();
          if (productId && !productIds.includes(productId)) {
            productIds.push(productId);
          }
        }
      });

      return { ids: productIds, msg: `共找到 ${productIds.length} 个ID` };
    } catch (error) {
      console.warn("ID提取失败：", error);
      return { ids: [], msg: "ID提取失败" };
    }
  }

  /**
   * 获取未请求过的新商品ID
   * @returns {array} 新ID数组
   */
  function getNewProductIds() {
    const currentIds = extractProductIds().ids;
    return currentIds.filter((id) => !requestedProductIds.includes(id));
  }

  /**
   * 显示顶部提示框
   * @param {string} text 提示文本
   * @param {string} type 类型：success/error
   */
  function showTip(text, type) {
    try {
      let tipElement = document.getElementById("request-tip");
      if (!tipElement) {
        // 创建提示框
        tipElement = document.createElement("div");
        tipElement.id = "request-tip";
        tipElement.style.cssText = `
                    position:fixed;
                    top:80px;
                    right:20px;
                    padding:8px 15px;
                    border-radius:4px;
                    color:white;
                    font-size:12px;
                    z-index:99999999;
                    box-shadow:0 2px 8px rgba(0,0,0,0.3);
                    transition:opacity 0.3s;
                    pointer-events:none;
                `;
        document.body.appendChild(tipElement);
      }

      // 设置提示内容和样式
      tipElement.textContent = text;
      tipElement.style.background = type === "error" ? "#FF5722" : "#4CAF50";
      tipElement.style.opacity = "1";

      // 风控提示显示10秒，普通提示显示3秒
      const duration = text.includes("请求太频繁被限制") ? 10000 : 3000;
      setTimeout(() => {
        if (tipElement) tipElement.style.opacity = "0";
      }, duration);
    } catch (error) {
      console.warn("提示显示失败：", error);
    }
  }

  /**
   * 从接口响应中提取关键指标（支付金额、访客数、加购件数）
   * @param {string} responseText 接口响应文本
   * @returns {object} 提取结果
   */
  function extractMetrics(responseText) {
    // 先检测是否是风控数据（商品指标接口）
    if (isRateLimitData(responseText, "sycm")) {
      return {
        payAmt: {
          success: false,
          value: "",
          msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
        },
        itmUv: {
          success: false,
          value: "",
          msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
        },
        itemCartCnt: {
          success: false,
          value: "",
          msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
        },
      };
    }

    try {
      const responseData = JSON.parse(responseText);
      let payAmt = null; // 支付金额
      let itmUv = null; // 访客数
      let itemCartCnt = null; // 加购件数

      // 多层级提取数据（兼容不同返回格式）
      if (
        responseData.data &&
        Array.isArray(responseData.data.data) &&
        responseData.data.data.length > 0
      ) {
        const item = responseData.data.data[0];
        payAmt = item.payAmt?.value ?? payAmt;
        itmUv = item.itmUv?.value ?? itmUv;
        itemCartCnt = item.itemCartCnt?.value ?? itemCartCnt;
      }
      if (
        !payAmt &&
        responseData.data &&
        responseData.data.list &&
        responseData.data.list.length > 0
      ) {
        const item = responseData.data.list[0];
        payAmt = item.indices?.payAmt?.value ?? payAmt;
        itmUv = item.indices?.itmUv?.value ?? itmUv;
        itemCartCnt = item.indices?.itemCartCnt?.value ?? itemCartCnt;
      }
      // 兜底提取
      payAmt =
        responseData.data?.indices?.payAmt?.value ??
        responseData.indices?.payAmt?.value ??
        payAmt;
      itmUv =
        responseData.data?.indices?.itmUv?.value ??
        responseData.indices?.itmUv?.value ??
        itmUv;
      itemCartCnt =
        responseData.data?.indices?.itemCartCnt?.value ??
        responseData.indices?.itemCartCnt?.value ??
        itemCartCnt;

      // 组装返回结果
      return {
        payAmt: {
          success: payAmt !== null && payAmt !== undefined,
          value: payAmt || "",
          msg:
            payAmt !== null && payAmt !== undefined
              ? `成功提取支付金额：${formatNumber(payAmt)}`
              : "响应数据中未找到payAmt参数",
        },
        itmUv: {
          success: itmUv !== null && itmUv !== undefined,
          value: itmUv || "",
          msg:
            itmUv !== null && itmUv !== undefined
              ? `成功提取访客数：${itmUv}`
              : "响应数据中未找到itmUv参数",
        },
        itemCartCnt: {
          success: itemCartCnt !== null && itemCartCnt !== undefined,
          value: itemCartCnt ?? "",
          msg:
            itemCartCnt !== null && itemCartCnt !== undefined
              ? `成功提取加购件数：${itemCartCnt}`
              : "响应数据中未找到itemCartCnt参数",
        },
      };
    } catch (error) {
      return {
        payAmt: {
          success: false,
          value: "",
          msg: `提取支付金额失败：${error.message}`,
        },
        itmUv: {
          success: false,
          value: "",
          msg: `提取访客数失败：${error.message}`,
        },
        itemCartCnt: {
          success: false,
          value: "",
          msg: `提取加购件数失败：${error.message}`,
        },
      };
    }
  }

  /**
   * 响应/msg 包含「被挤爆啦」或「请求太频繁被限制」时视为请求失败（被限制），显示「请求失败」；其他失败显示暂无数据
   * @param {string} msg 接口返回的 msg
   * @returns {boolean}
   */
  function isRateLimitFailure(msg) {
    if (typeof msg !== "string") return false;
    return msg.includes("被挤爆啦") || msg.includes("请求太频繁被限制");
  }

  /**
   * 获取指定商品ID的支付金额
   * @param {string} productId 商品ID
   * @returns {string} 支付金额（格式化后）
   */
  function getPayAmt(productId) {
    const result = requestResults.find((item) => item.productId === productId);
    if (result && result.payAmt && result.payAmt.success) {
      return formatNumber(result.payAmt.value);
    }
    if (result && result.payAmt) {
      return isRateLimitFailure(result.payAmt.msg) ? "请求失败" : "暂无数据";
    }
    return "待请求";
  }

  /**
   * 获取指定商品ID的加购件数
   * @param {string} productId 商品ID
   * @returns {string} 加购件数
   */
  function getCartCount(productId) {
    const result = requestResults.find((item) => item.productId === productId);
    if (result && result.itemCartCnt && result.itemCartCnt.success) {
      return result.itemCartCnt.value;
    }
    if (result && result.itemCartCnt) {
      return isRateLimitFailure(result.itemCartCnt.msg) ? "请求失败" : "暂无数据";
    }
    return "待请求";
  }

  /**
   * 获取指定商品ID的访客数
   * @param {string} productId 商品ID
   * @returns {string} 访客数
   */
  function getVisitorCount(productId) {
    const result = requestResults.find((item) => item.productId === productId);
    if (result && result.itmUv && result.itmUv.success) {
      return result.itmUv.value;
    }
    if (result && result.itmUv) {
      return isRateLimitFailure(result.itmUv.msg) ? "请求失败" : "暂无数据";
    }
    return "待请求";
  }

  /**
   * 获取指定商品ID的实收款（actualFee）
   * @param {string} productId 商品ID
   * @returns {string} 实收款
   */
  function getActualFee(productId) {
    const result = requestResults.find((item) => item.productId === productId);
    
    // 调试：打印getActualFee函数的查找结果
    console.log(`商品${productId}的getActualFee查找结果:`, result);
    
    if (result && result.actualFee) {
      if (result.actualFee.success) {
        // 获取订单详情（支持从value或orderDetails字段获取）
        const orderDetails = (result.actualFee.orderDetails || result.actualFee.value || []);
        
        // 如果只有一个订单且是简单格式（订单ID为"订单总额"），直接显示金额
        if (orderDetails.length === 1 && orderDetails[0].orderId === "订单总额") {
          return orderDetails[0].realTotal;
        } else {
          // 否则显示订单数量和小于10元的订单数
          const orderCount = orderDetails.length;
          // 统计实收款小于10元的订单数
          const lowAmountOrderCount = orderDetails.filter(order => {
            const amount = parseFloat(order.realTotal);
            return !isNaN(amount) && amount < 10;
          }).length;
          return `${orderCount}个订单 (小于10元: ${lowAmountOrderCount}个)`;
        }
      }
      return isRateLimitFailure(result.actualFee.msg) ? "请求失败" : "暂无数据";
    }
    return "待请求";
  }

  /**
   * 新增：获取actualFee的请求函数
   * @param {string} productId 商品ID
   * @returns {Promise} 请求结果Promise
   */
  function singleActualFeeRequest(productId) {
    // 风控状态下直接返回失败（未发起请求，无响应内容，显示暂无数据）
    if (isRateLimited) {
      return Promise.resolve({
        success: false,
        value: "",
        msg: "请求太频繁被限制",
        responseText:
          '{"rgv587_flag":"sm","url":"https://bixi.alicdn.com/punish/..."}',
      });
    }

    return new Promise((resolve) => {
      const cookies = extractCookies();

      // 检查cookie2是否填写
      if (!globalCookie2 || globalCookie2.trim() === "") {
        resolve({
          success: false,
          value: "",
          msg: "cookie2未填写",
          responseText: "cookie2未填写",
        });
        return;
      }

      // 检查商品ID是否为空
      if (!productId) {
        resolve({
          success: false,
          value: "",
          msg: "产品ID为空",
          responseText: "产品ID为空",
        });
        return;
      }

      try {
        // 构建Cookie字符串
        const cookieStr = `cookie2=${globalCookie2}; _m_h5_tk=${cookies._m_h5_tk}; _m_h5_tk_enc=${cookies._m_h5_tk_enc};`;

        // 构建请求体
        const formData = new URLSearchParams();
        formData.append("isQnNew", "true");
        formData.append("isHideNick", "true");
        formData.append("prePageNo", "1");
        formData.append("sifg", "0");
        formData.append("action", "itemlist/SoldQueryAction");
        formData.append("close", "0");
        formData.append("pageNum", "1");
        formData.append("tabCode", "latest3Months");
        formData.append("useCheckcode", "false");
        formData.append("errorCheckcode", "false");
        formData.append("payDateBegin", "0");
        formData.append("rateStatus", "ALL");
        formData.append("unionSearch", productId); // 商品ID填入unionSearch
        formData.append("buyerNick", "");
        formData.append("orderStatus", "ALL");
        formData.append("pageSize", "15");
        formData.append("dateEnd", "0");
        formData.append("rxOldFlag", "0");
        formData.append("rxSendFlag", "0");
        formData.append("dateBegin", "0");
        formData.append("tradeTag", "0");
        formData.append("rxHasSendFlag", "0");
        formData.append("auctionType", "0");
        formData.append("sellerNick", "");
        formData.append("notifySendGoodsType", "ALL");
        formData.append("sellerMemoFlag", "0");
        formData.append("useOrderInfo", "false");
        formData.append("logisticsService", "ALL");
        formData.append("o2oDeliveryType", "ALL");
        formData.append("rxAuditFlag", "0");
        formData.append("auctionId", "");
        formData.append("queryOrder", "desc");
        formData.append("holdStatus", "0");
        formData.append("rxElectronicAuditFlag", "0");
        formData.append("bizOrderId", "");
        formData.append("queryMore", "false");
        formData.append("payDateEnd", "0");
        formData.append("rxWaitSendflag", "0");
        formData.append("sellerMemo", "0");
        formData.append("queryBizType", "ALL");
        formData.append("rxElectronicAllFlag", "0");
        formData.append("rxSuccessflag", "0");
        formData.append("unionSearchTotalNum", "0");
        formData.append("refund", "ALL");
        formData.append("unionSearchPageNum", "0");
        formData.append("yushouStatus", "ALL");
        formData.append("deliveryTimeType", "ALL");
        formData.append("payMethodType", "ALL");
        formData.append("orderType", "ALL");
        formData.append("appName", "ALL");

        // 请求头
        const headers = {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookieStr,
          origin: "https://myseller.taobao.com",
          priority: "u=1, i",
          referer:
            "https://myseller.taobao.com/home.htm/trade-platform/tp/sold",
          "sec-ch-ua":
            '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        };

        // 发送POST请求
        GM_xmlhttpRequest({
          method: "POST",
          url: "https://trade.taobao.com/trade/itemlist/asyncSold.htm?event_submit_do_query=1&_input_charset=utf8",
          headers: headers,
          data: formData.toString(),
          timeout: 10000, // 10秒超时
          onload: (response) => {
            try {
              // 检测风控数据（actualFee 接口，仅标记 trade，不影响主接口继续请求）
              if (isRateLimitData(response.responseText, "trade")) {
                showTip(
                  "⚠️ actualFee 请求被限制，其他数据继续请求",
                  "error",
                );
                const burstMsg = response.responseText.includes("被挤爆啦") ? "被挤爆啦" : "请求太频繁被限制";
                resolve({
                  success: false,
                  value: "",
                  msg: burstMsg,
                  responseText: response.responseText,
                });
                return;
              }

              // 提取actualFee - 使用字符串解析方式
              let orderDetails = [];
              let formattedResponseText = response.responseText;

              try {
                // 尝试使用字符串解析方式提取订单信息
                
                // 先尝试JSON解析，如果失败再用字符串正则提取
                try {
                  const responseData = JSON.parse(response.responseText);
                  
                  // 调试：打印完整的JSON数据结构
                  console.log("完整JSON数据结构:", responseData);
                  
                  // 首先尝试提取简单的actualFee字段
                  let actualFeeValue = null;
                  
                  // 检查多种可能的JSON路径
                  if (typeof responseData === 'object' && responseData !== null) {
                    // 路径1：直接在responseData中
                    if (responseData.actualFee) {
                      actualFeeValue = responseData.actualFee;
                    }
                    // 路径2：在responseData.data中
                    else if (responseData.data && responseData.data.actualFee) {
                      actualFeeValue = responseData.data.actualFee;
                    }
                    // 路径3：在responseData.result中
                    else if (responseData.result && responseData.result.actualFee) {
                      actualFeeValue = responseData.result.actualFee;
                    }
                    // 路径4：在responseData.content中
                    else if (responseData.content && responseData.content.actualFee) {
                      actualFeeValue = responseData.content.actualFee;
                    }
                    // 路径5：在responseData.response中
                    else if (responseData.response && responseData.response.actualFee) {
                      actualFeeValue = responseData.response.actualFee;
                    }
                    // 路径6：在responseData.data.result中
                    else if (responseData.data?.result?.actualFee) {
                      actualFeeValue = responseData.data.result.actualFee;
                    }
                    // 路径7：在responseData.data.content中
                    else if (responseData.data?.content?.actualFee) {
                      actualFeeValue = responseData.data.content.actualFee;
                    }
                  }
                  
                  // 如果找到了简单的actualFee值，创建一个包含该值的订单详情
                  if (actualFeeValue !== null) {
                    // 将actualFeeValue转换为字符串格式
                    const feeString = String(actualFeeValue);
                    // 创建一个包含该值的订单详情
                    orderDetails.push({
                      orderId: "订单总额",
                      realTotal: feeString,
                      orderTime: "",
                      orderStatus: ""
                    });
                    console.log("找到了简单格式的actualFee:", feeString);
                  } else {
                    // 如果没有简单的actualFee值，尝试提取mainOrders（复杂格式）
                    // 尝试多种可能的JSON路径，支持mainOrders为数组或对象
                    let mainOrders = [];
                    
                    // 路径1：直接在responseData中
                    if (Array.isArray(responseData.mainOrders)) {
                      mainOrders = responseData.mainOrders;
                    } else if (responseData.mainOrders && typeof responseData.mainOrders === 'object') {
                      // mainOrders是对象，转换为单元素数组
                      mainOrders = [responseData.mainOrders];
                    }
                    // 路径2：在responseData.data中
                    else if (responseData.data) {
                      if (Array.isArray(responseData.data.mainOrders)) {
                        mainOrders = responseData.data.mainOrders;
                      } else if (responseData.data.mainOrders && typeof responseData.data.mainOrders === 'object') {
                        mainOrders = [responseData.data.mainOrders];
                      }
                    }
                    // 路径3：在responseData.result中
                    else if (responseData.result) {
                      if (Array.isArray(responseData.result.mainOrders)) {
                        mainOrders = responseData.result.mainOrders;
                      } else if (responseData.result.mainOrders && typeof responseData.result.mainOrders === 'object') {
                        mainOrders = [responseData.result.mainOrders];
                      }
                    }
                    // 路径4：在responseData.content中
                    else if (responseData.content) {
                      if (Array.isArray(responseData.content.mainOrders)) {
                        mainOrders = responseData.content.mainOrders;
                      } else if (responseData.content.mainOrders && typeof responseData.content.mainOrders === 'object') {
                        mainOrders = [responseData.content.mainOrders];
                      }
                    }
                    // 路径5：在responseData.data.content中
                    else if (responseData.data?.content) {
                      if (Array.isArray(responseData.data.content.mainOrders)) {
                        mainOrders = responseData.data.content.mainOrders;
                      } else if (responseData.data.content.mainOrders && typeof responseData.data.content.mainOrders === 'object') {
                        mainOrders = [responseData.data.content.mainOrders];
                      }
                    }
                    // 路径6：在responseData.response中
                    else if (responseData.response) {
                      if (Array.isArray(responseData.response.mainOrders)) {
                        mainOrders = responseData.response.mainOrders;
                      } else if (responseData.response.mainOrders && typeof responseData.response.mainOrders === 'object') {
                        mainOrders = [responseData.response.mainOrders];
                      }
                    }
                    // 路径7：在responseData.data.result中
                    else if (responseData.data?.result) {
                      if (Array.isArray(responseData.data.result.mainOrders)) {
                        mainOrders = responseData.data.result.mainOrders;
                      } else if (responseData.data.result.mainOrders && typeof responseData.data.result.mainOrders === 'object') {
                        mainOrders = [responseData.data.result.mainOrders];
                      }
                    }
                    
                    if (mainOrders.length > 0) {
                      // 统计主订单数量（不统计子订单）
                      mainOrders.forEach((mainOrder) => {
                        // 获取主订单ID
                        const mainOrderId = mainOrder.id || 
                                          mainOrder.orderInfo?.id || 
                                          mainOrder.orderId || 
                                          mainOrder.order_id || 
                                          "未知主订单ID";
                        
                        // 优先获取主订单的actualFee值
                        let mainOrderTotal = null;
                        
                        // 尝试直接获取主订单的actualFee
                        if (mainOrder.actualFee) {
                          mainOrderTotal = parseFloat(mainOrder.actualFee);
                        }
                        // 尝试从mainOrder.payInfo中获取actualFee（新增，解决用户提供的订单数据问题）
                        else if (mainOrder.payInfo && mainOrder.payInfo.actualFee) {
                          mainOrderTotal = parseFloat(mainOrder.payInfo.actualFee);
                        }
                        // 尝试从mainOrder.priceInfo中获取actualFee
                        else if (mainOrder.priceInfo && mainOrder.priceInfo.actualFee) {
                          mainOrderTotal = parseFloat(mainOrder.priceInfo.actualFee);
                        }
                        // 尝试从mainOrder.data中获取actualFee
                        else if (mainOrder.data && mainOrder.data.actualFee) {
                          mainOrderTotal = parseFloat(mainOrder.data.actualFee);
                        }
                        // 尝试从mainOrder.info中获取actualFee
                        else if (mainOrder.info && mainOrder.info.actualFee) {
                          mainOrderTotal = parseFloat(mainOrder.info.actualFee);
                        }
                        // 尝试直接获取主订单的总金额（兼容旧逻辑）
                        else if (mainOrder.priceInfo && mainOrder.priceInfo.realTotal) {
                          mainOrderTotal = parseFloat(mainOrder.priceInfo.realTotal);
                        }
                        // 检查是否找到了有效金额
                        if (mainOrderTotal === null || isNaN(mainOrderTotal)) {
                          console.warn(`主订单${mainOrderId}未找到有效actualFee值`);
                        }
                        
                        // 获取订单时间
                        const orderTime = mainOrder.createTime || 
                                         mainOrder.orderInfo?.createTime || 
                                         mainOrder.orderTime || 
                                         "未知时间";
                        
                        // 获取订单状态
                        const orderStatus = mainOrder.statusInfo?.text || 
                                           mainOrder.statusText || 
                                           mainOrder.orderStatus || 
                                           "未知状态";
                        
                        // 添加主订单信息（不细分到子订单）
                        orderDetails.push({
                          orderId: mainOrderId,
                          realTotal: mainOrderTotal !== null && !isNaN(mainOrderTotal) ? mainOrderTotal.toFixed(2) : "暂无数据",
                          orderTime: orderTime,
                          orderStatus: orderStatus
                        });
                      });
                    } else {
                      console.log("未找到mainOrders数组和actualFee字段");
                    }
                  }
                } catch (jsonError) {
                  // JSON解析失败，使用字符串正则提取
                        console.warn("JSON解析失败，尝试字符串正则提取：", jsonError);
                        
                        // 首先尝试提取简单格式的"actualFee": "105.00"
                        const simpleActualFeeRegex = /"actualFee"\s*:\s*(?:"([^"]+)"|(\d+\.?\d*))/;
                        const simpleMatch = simpleActualFeeRegex.exec(response.responseText);
                        
                        if (simpleMatch) {
                          const feeValue = simpleMatch[1] || simpleMatch[2];
                          orderDetails.push({
                            orderId: "订单总额",
                            realTotal: feeValue,
                            orderTime: "",
                            orderStatus: ""
                          });
                          console.log("字符串正则提取到简单格式的actualFee:", feeValue);
                        } else {
                          // 尝试提取复杂格式的mainOrders
                          // 优化的字符串解析逻辑
                          // 1. 提取mainOrders（支持数组和对象格式）
                          let mainOrdersText = '';
                          let mainOrderMatch;
                          
                          // 首先尝试匹配数组格式
                          const mainOrderArrayRegex = /"mainOrders"\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/g;
                          mainOrderMatch = mainOrderArrayRegex.exec(response.responseText);
                          
                          if (mainOrderMatch && mainOrderMatch[1]) {
                            mainOrdersText = mainOrderMatch[1];
                          } else {
                            // 尝试匹配对象格式
                            const mainOrderObjectRegex = /"mainOrders"\s*:\s*\{([\s\S]*?)\}\s*(?:,|\})/g;
                            mainOrderMatch = mainOrderObjectRegex.exec(response.responseText);
                            
                            if (mainOrderMatch && mainOrderMatch[1]) {
                              // 如果是对象，将其转换为类似数组元素的格式
                              mainOrdersText = '{' + mainOrderMatch[1] + '}';
                            }
                          }
                          
                          if (mainOrdersText) {
                            
                            // 2. 提取所有主订单对象（改进的正则表达式，支持嵌套对象）
                            // 使用更强大的正则表达式，能够正确处理嵌套对象结构
                            const singleMainOrderRegex = /\{\s*"id"\s*:\s*(?:"([^"]+)"|(\d+))[\s\S]*?\}(?=\s*(?:,\s*\{\s*"id"|$))/g;
                            let singleMainOrderMatch;
                            
                            while ((singleMainOrderMatch = singleMainOrderRegex.exec(mainOrdersText)) !== null) {
                              const orderId = (singleMainOrderMatch[1] || singleMainOrderMatch[2]) || "未知主订单ID";
                              const mainOrderText = singleMainOrderMatch[0];
                              
                              // 3. 提取实付金额（尝试多种方式）
                              let realTotal = "暂无数据";
                              
                              // 优先提取主订单的actualFee
                              const actualFeeRegex = /"actualFee"\s*:\s*(?:"([^"]+)"|([\d.]+))/;
                              const actualFeeMatch = actualFeeRegex.exec(mainOrderText);
                              if (actualFeeMatch) {
                                realTotal = actualFeeMatch[1] || actualFeeMatch[2]; 
                              }
                              // 尝试从mainOrder.payInfo.actualFee中提取（新增，支持嵌套对象）
                              else {
                                // 使用更强大的正则表达式处理嵌套对象结构
                                const payInfoActualFeeRegex = /"payInfo"\s*:\s*\{[\s\S]*?"actualFee"\s*:\s*(?:"([^"]+)"|([\d.]+))/;
                                const payInfoMatch = payInfoActualFeeRegex.exec(mainOrderText);
                                if (payInfoMatch) {
                                  realTotal = payInfoMatch[1] || payInfoMatch[2];
                                }
                                // 尝试从mainOrder.priceInfo.actualFee中提取（支持嵌套对象）
                                else {
                                  const priceInfoActualFeeRegex = /"priceInfo"\s*:\s*\{[\s\S]*?"actualFee"\s*:\s*(?:"([^"]+)"|([\d.]+))/;
                                  const priceInfoMatch = priceInfoActualFeeRegex.exec(mainOrderText);
                                  if (priceInfoMatch) {
                                    realTotal = priceInfoMatch[1] || priceInfoMatch[2];
                                  }
                                  // 尝试从mainOrder.data.actualFee中提取（支持嵌套对象）
                                  else {
                                    const dataActualFeeRegex = /"data"\s*:\s*\{[\s\S]*?"actualFee"\s*:\s*(?:"([^"]+)"|([\d.]+))/;
                                    const dataMatch = dataActualFeeRegex.exec(mainOrderText);
                                    if (dataMatch) {
                                      realTotal = dataMatch[1] || dataMatch[2];
                                    }
                                    // 尝试从mainOrder.info.actualFee中提取（支持嵌套对象）
                                    else {
                                      const infoActualFeeRegex = /"info"\s*:\s*\{[\s\S]*?"actualFee"\s*:\s*(?:"([^"]+)"|([\d.]+))/;
                                      const infoMatch = infoActualFeeRegex.exec(mainOrderText);
                                      if (infoMatch) {
                                        realTotal = infoMatch[1] || infoMatch[2];
                                      }
                                    // 最后尝试提取realTotal（兼容旧逻辑）
                                    else {
                                      const realTotalRegex = /"realTotal"\s*:\s*([\d.]+)/;
                                      const realTotalMatch = realTotalRegex.exec(mainOrderText);
                                      if (realTotalMatch) {
                                        realTotal = realTotalMatch[1];
                                      }
                                    }
                                  }
                                }
                              }
                              
                              // 4. 提取订单时间
                              // 先尝试从orderInfo中提取
                              const orderInfoTimeRegex = /"orderInfo"\s*:\s*\{[\s\S]*?"createTime"\s*:\s*"([^"]+)"/;
                              const orderInfoTimeMatch = orderInfoTimeRegex.exec(mainOrderText);
                              // 如果没找到，尝试直接提取
                              const directTimeRegex = /"createTime"\s*:\s*"([^"]+)"/;
                              const directTimeMatch = directTimeRegex.exec(mainOrderText);
                              const orderTime = orderInfoTimeMatch ? orderInfoTimeMatch[1] : 
                                               (directTimeMatch ? directTimeMatch[1] : "未知时间");
                              
                              // 5. 提取订单状态
                              // 先尝试从statusInfo中提取
                              const statusInfoRegex = /"statusInfo"\s*:\s*\{[\s\S]*?"text"\s*:\s*"([^"]+)"/;
                              const statusInfoMatch = statusInfoRegex.exec(mainOrderText);
                              // 如果没找到，尝试直接提取statusText
                              const statusTextRegex = /"statusText"\s*:\s*"([^"]+)"/;
                              const statusTextMatch = statusTextRegex.exec(mainOrderText);
                              // 如果还没找到，尝试直接提取status
                              const statusRegex = /"status"\s*:\s*"([^"]+)"/;
                              const statusMatch = statusRegex.exec(mainOrderText);
                              const orderStatus = statusInfoMatch ? statusInfoMatch[1] : 
                                               (statusTextMatch ? statusTextMatch[1] : 
                                               (statusMatch ? statusMatch[1] : "未知状态"));
                              
                              // 6. 添加主订单信息
                              orderDetails.push({
                                orderId: orderId,
                                realTotal: realTotal,
                                orderTime: orderTime,
                                orderStatus: orderStatus
                              });
                            }
                          }
                          }
                        }
                        
                        // 调试：打印提取结果
                        console.log("订单详情提取结果:", orderDetails);
                }
              } catch (error) {
                console.warn(`ID ${productId}：actualFee解析失败：`, error);
                showTip(`ID ${productId}：actualFee解析失败`, "error");
              }

              // 返回结果
              resolve({
                success: orderDetails.length > 0,
                value: orderDetails, // 直接返回订单详情列表（主订单）
                msg:
                  orderDetails.length > 0
                    ? `成功提取${orderDetails.length}个主订单的actualFee数据`
                    : "响应数据中未找到actualFee参数",
                responseText: formattedResponseText,
                rawText: response.responseText,
                orderDetails: orderDetails, // 保存订单详情（主订单）
              });
              
              // 调试：打印返回结果
              console.log("singleActualFeeRequest返回结果:", {
                success: orderDetails.length > 0,
                value: orderDetails,
                msg: orderDetails.length > 0 ? `成功提取${orderDetails.length}个主订单的actualFee数据` : "响应数据中未找到actualFee参数",
                orderDetails: orderDetails
              });
            } catch (error) {
              resolve({
                success: false,
                value: "",
                msg: `请求成功但处理失败：${error.message}`,
                responseText: error.message,
              });
            }
          },
          onerror: (error) => {
            resolve({
              success: false,
              value: "",
              msg: `请求失败：${error.message || "网络错误"}`,
              responseText: error.message || "网络错误",
            });
          },
          ontimeout: () => {
            resolve({
              success: false,
              value: "",
              msg: "请求超时（10秒）",
              responseText: "请求超时（10秒）",
            });
          },
        });
      } catch (error) {
        resolve({
          success: false,
          value: "",
          msg: `请求异常：${error.message}`,
          responseText: error.message,
        });
      }
    });
  }

  /**
   * 在商品ID旁渲染指标数据（支付金额、访客数、加购件数、actualFee）
   */
  function renderMetrics() {
    try {
      // 1. 处理原有的商品ID指标渲染
      const productElements = document.querySelectorAll(".product-desc-span");
      productElements.forEach((element) => {
        const text = element.textContent?.trim() || "";
        const idMatch = text.match(/ID[:：]\s*(.+)/);
        if (!idMatch || !idMatch[1]) return;

        const productId = idMatch[1].trim();
        let metricsNode = element.nextElementSibling;

        // 创建指标显示节点（如果不存在）
        if (
          !metricsNode ||
          !metricsNode.classList.contains("sycm-metrics-node")
        ) {
          metricsNode = document.createElement("span");
          metricsNode.classList.add("sycm-metrics-node");
          metricsNode.style.cssText = `
                        margin-left: -6px;
                        padding: 2px 0px;
                        border-radius: 3px;
                        font-size: 11px;
                        font-weight: bold;
                    `;
          element.parentNode.insertBefore(metricsNode, element.nextSibling);
        }

        // 始终用 requestResults 中的实际数据显示，风控时也不替换为整页提示（保留之前请求成功的数据）
        const payAmt = getPayAmt(productId);
        const visitorCount = getVisitorCount(productId);
        const cartCount = getCartCount(productId);
        const actualFee = getActualFee(productId); // 保留actualFee获取，用于数据有效性判断

        // 判断是否有有效数据（任意一项有数据则显示绿色）
        const hasValidData = 
          (payAmt !== "待请求" && payAmt !== "暂无数据" && payAmt !== "请求失败") ||
          (visitorCount !== "待请求" && visitorCount !== "暂无数据" && visitorCount !== "请求失败") ||
          (cartCount !== "待请求" && cartCount !== "暂无数据" && cartCount !== "请求失败");

        // 设置样式：有有效数据=绿色，三项全是暂无数据=黄色，其余（含请求失败/待请求）=红色
        let bgColor = "#f5f5f5";
        let textColor = "#999";
        if (hasValidData) {
          bgColor = "#e8f5e9";
          textColor = "#2e7d32";
        } else if (
          payAmt === "暂无数据" &&
          visitorCount === "暂无数据" &&
          cartCount === "暂无数据"
        ) {
          bgColor = "#fff8e1";
          textColor = "#f57f17";
        } else if (
          payAmt === "暂无数据" || payAmt === "请求失败" ||
          visitorCount === "暂无数据" || visitorCount === "请求失败" ||
          cartCount === "暂无数据" || cartCount === "请求失败"
        ) {
          bgColor = "#ffebee";
          textColor = "#FF5722";
        }

        // 渲染内容（移除实收款，实收款仅在弹框中显示）
        metricsNode.style.background = bgColor;
        metricsNode.style.color = textColor;
        metricsNode.textContent = `【近30天】支付金额:${payAmt} | 访客数:${visitorCount} | 加购件数:${cartCount}`;
      });
      
      // 从销量行元素解析出商品ID（与点击逻辑一致）
      const getProductIdFromSoldRow = (el) => {
        let productId = null;
        const currentRow = el.closest(".l-config-list-row");
        if (currentRow) {
          const productDescSpan = currentRow.querySelector(".product-desc-span");
          if (productDescSpan) {
            const text = productDescSpan.textContent?.trim() || "";
            const idMatch = text.match(/ID[:：]\s*(.+)/);
            if (idMatch && idMatch[1]) productId = idMatch[1].trim();
          }
        }
        if (!productId && el.parentElement) {
          let currentElement = el;
          for (let i = 0; i < 5; i++) {
            if (!currentElement) break;
            currentElement = currentElement.parentElement;
            if (currentElement) {
              const text = currentElement.textContent?.trim() || "";
              const idMatch = text.match(/ID[:：]\s*(\d+)/);
              if (idMatch && idMatch[1]) { productId = idMatch[1].trim(); break; }
              if (currentElement.dataset && currentElement.dataset.productId) { productId = currentElement.dataset.productId; break; }
              if (currentElement.id && /\d+/.test(currentElement.id)) { productId = currentElement.id.match(/\d+/)[0]; break; }
            }
          }
        }
        return productId;
      };

      // 在销量显示元素右侧添加查看详情按钮
      const soldQuantityElements = document.querySelectorAll(".l-form-text.l-config-list-cell-text-soldQuantity_m");
      soldQuantityElements.forEach((element) => {
        // 检查是否已添加过按钮，避免重复添加
        if (!element.dataset.detailButtonAdded) {
          const detailButton = document.createElement("button");
          detailButton.textContent = "等待请求";
          detailButton.style.cssText = `
            margin-left: 8px;
            padding: 2px 8px;
            background-color: #9e9e9e;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          `;
          const hintDiv = document.createElement("div");
          hintDiv.style.cssText = "font-size: 11px; color: #FF5722; margin-top: 4px; margin-left: 8px; display: none;";
          hintDiv.innerHTML = '请点此<a href="https://myseller.taobao.com/home.htm/trade-platform/tp/sold" target="_blank" rel="noopener noreferrer" style="color:#2196F3;text-decoration:underline;">交易-已卖出宝贝</a>跳转页面过滑块验证';

          // 添加点击事件
          detailButton.addEventListener("click", () => {
            const productId = getProductIdFromSoldRow(element);
            
            // 直接从requestResults中获取订单详情数据
            const result = requestResults.find((item) => item.productId === productId);
            const actualFeeResult = result && result.actualFee;
            
            // 创建遮罩层
            const overlay = document.createElement("div");
            overlay.style.cssText = `
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background-color: rgba(0, 0, 0, 0.5);
              z-index: 999999;
              display: flex;
              justify-content: center;
              align-items: center;
            `;
            
            // 创建弹框
            const modal = document.createElement("div");
            modal.style.cssText = `
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              width: 600px;
              max-width: 90%;
              max-height: 80%;
              overflow-y: auto;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
              position: relative;
            `;
            
            // 创建关闭按钮
            const closeBtn = document.createElement("button");
            closeBtn.textContent = "×";
            closeBtn.style.cssText = `
              position: absolute;
              top: 10px;
              right: 15px;
              background: none;
              border: none;
              font-size: 24px;
              cursor: pointer;
              color: #666;
            `;
            
            // 创建弹框内容
            const modalContent = document.createElement("div");
            
            // 显示主订单actualFee详细数据
            if (productId) {
              if (actualFeeResult && actualFeeResult.success) {
                // 获取订单详情（支持从value或orderDetails字段获取）
                const orderDetails = actualFeeResult.orderDetails || actualFeeResult.value || [];
                
                // 添加总计与按交易状态分类
                let totalActualFee = "0个订单";
                /** @type {Record<string, number>} 按订单状态统计数量 */
                const statusCount = {};
                
                if (orderDetails.length === 1 && orderDetails[0].orderId === "订单总额") {
                  totalActualFee = orderDetails[0].realTotal;
                } else if (orderDetails.length > 0) {
                  const orderCount = orderDetails.length;
                  totalActualFee = `${orderCount}个订单`;
                  orderDetails.forEach(order => {
                    const status = (order.orderStatus && String(order.orderStatus).trim()) || "未知";
                    statusCount[status] = (statusCount[status] || 0) + 1;
                  });
                }
                
                const statusLines = Object.keys(statusCount).length > 0
                  ? Object.entries(statusCount).map(([status, n]) => `${status}：${n}个`).join("　")
                  : "";
                
                let html = `<h3 style="margin-top: 0; color: #333;">商品ID: ${productId} - 近3个月订单数据</h3>`;
                html += `<div style="margin-bottom: 15px; padding: 10px; background-color: #fff3e0; border-left: 4px solid #ff9800; border-radius: 3px;">`;
                html += `<div style="font-weight: bold; color: #f57c00;">总计: ${totalActualFee}</div>`;
                if (statusLines) {
                  html += `<div style="color: #757575; margin-top: 5px;">${statusLines}</div>`;
                }
                html += `</div>`;
                html += `<div style="margin-bottom: 10px; font-size: 12px; color: #9e9e9e;">数据来源：交易-已卖出宝贝-近3个月订单（实际会有超过3个月的订单数据）</div>`;
                  
                  if (orderDetails.length > 0) {
                    html += `<div style="margin-top: 10px;">`;
                    orderDetails.forEach((order, index) => {
                      html += `<div style="margin-bottom: 15px; padding: 10px; background-color: #f5f5f5; border-radius: 4px;">`;
                      html += `<h4 style="margin-top: 0; color: #4CAF50;">主订单 ${index + 1}</h4>`;
                      
                      // 显示订单详情
                      if (order.orderId) html += `<div>订单号: ${order.orderId}</div>`;
                      if (order.realTotal) html += `<div>实收款: <strong style="color: #FF5722;">¥${order.realTotal}</strong></div>`;
                      if (order.orderTime) html += `<div>订单时间: ${order.orderTime}</div>`;
                      if (order.orderStatus) html += `<div>订单状态: ${order.orderStatus}</div>`;
                      
                      // 显示子订单信息（如果有）
                      if (order.subOrders && order.subOrders.length > 0) {
                        html += `<div style="margin-top: 10px; padding-left: 10px; border-left: 2px solid #ddd;">`;
                        html += `<h5 style="margin-top: 0; color: #2196F3;">子订单信息</h5>`;
                        order.subOrders.forEach((subOrder, subIndex) => {
                          html += `<div style="margin-top: 5px; font-size: 14px;">`;
                          html += `<div>子订单 ${subIndex + 1}: `;
                          if (subOrder.subOrderId) html += `子订单号: ${subOrder.subOrderId} `;
                          if (subOrder.quantity) html += `数量: ${subOrder.quantity} `;
                          if (subOrder.subRealTotal) html += `实收款: <strong style="color: #FF5722;">¥${subOrder.subRealTotal}</strong>`;
                          if (subOrder.productName) html += `<div style="margin-left: 15px;">商品名称: ${subOrder.productName}</div>`;
                          html += `</div>`;
                        });
                        html += `</div>`;
                      }
                      
                      html += `</div>`;
                    });
                    html += `</div>`;
                  } else {
                    html += `<p>暂无主订单数据</p>`;
                  }
                  
                  modalContent.innerHTML = html;
              }
            } else if (actualFeeResult && !actualFeeResult.success) {
              // 显示请求失败；凡被限制（被挤爆或请求太频繁）均显示滑块验证提示
              const showSliderHint = isRateLimitFailure(actualFeeResult.msg);
              modalContent.innerHTML = `
                <h3 style="margin-top: 0; color: #333;">商品ID: ${productId} - 实收款</h3>
                <p style="color: #FF5722;">请求失败</p>
                ${showSliderHint ? `<p style="color: #FF9800; margin-top: 10px; font-size: 13px;">请去<a href="https://myseller.taobao.com/home.htm/trade-platform/tp/sold" target="_blank" rel="noopener noreferrer" style="color:#2196F3;text-decoration:underline;">交易-已卖出宝贝</a>页面过滑块验证</p>` : ""}
              `;
            } else if (!actualFeeResult) {
              // 数据还未请求或不存在
              modalContent.innerHTML = `
                <h3 style="margin-top: 0; color: #333;">商品ID: ${productId} - 实收款</h3>
                <p style="color: #FF5722;">数据尚未获取或请求中...</p>
              `;
            } else {
              modalContent.innerHTML = `
                <h3 style="margin-top: 0; color: #333;">详情信息</h3>
                <p style="color: #FF5722;">无法获取商品ID</p>
              `;
            }
            
            // 组装弹框
            modal.appendChild(closeBtn);
            modal.appendChild(modalContent);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            
            // 关闭弹框的函数
            const closeModal = () => {
              document.body.removeChild(overlay);
            };
            
            // 点击关闭按钮关闭弹框
            closeBtn.addEventListener("click", closeModal);
            
            // 点击遮罩层关闭弹框
            overlay.addEventListener("click", (e) => {
              if (e.target === overlay) {
                closeModal();
              }
            });
          });
          
          element._detailButton = detailButton;
          element._detailHint = hintDiv;
          element.dataset.detailButtonAdded = "true";
          element.parentNode.insertBefore(detailButton, element.nextSibling);
          element.parentNode.insertBefore(hintDiv, detailButton.nextSibling);
        }
      });

      // 根据 actualFee 状态更新按钮：未请求=灰色等待请求，请求失败=红色，无风控且无数据=黄色暂无数据，有数据=蓝色查看详情
      soldQuantityElements.forEach((element) => {
        if (!element._detailButton || !element._detailHint) return;
        const productId = getProductIdFromSoldRow(element);
        const actualFeeDisplay = productId ? getActualFee(productId) : "";
        if (actualFeeDisplay === "待请求") {
          element._detailButton.textContent = "等待请求";
          element._detailButton.style.backgroundColor = "#9e9e9e";
          element._detailButton.style.color = "white";
          element._detailHint.style.display = "none";
        } else if (actualFeeDisplay === "请求失败") {
          element._detailButton.textContent = "请求失败";
          element._detailButton.style.backgroundColor = "#FF5722";
          element._detailHint.style.display = "block";
        } else if (actualFeeDisplay === "暂无数据") {
          element._detailButton.textContent = "暂无数据";
          element._detailButton.style.backgroundColor = "#FFC107";
          element._detailButton.style.color = "#333";
          element._detailHint.style.display = "none";
        } else {
          element._detailButton.textContent = "查看详情";
          element._detailButton.style.backgroundColor = "#2196F3";
          element._detailButton.style.color = "white";
          element._detailHint.style.display = "none";
        }
      });

      updateFloatRetryButton();
      
    } catch (error) {
      console.warn("指标渲染失败：", error);
    }
  }
  
  // 已删除showActualFeeDetails函数

  /**
   * 复制文本到剪贴板
   * @param {string} text 要复制的文本
   * @param {string} productId 商品ID（用于提示）
   */
  function copyTextToClipboard(text, productId) {
    try {
      // 优先使用Clipboard API
      navigator.clipboard
        .writeText(text)
        .then(() => {
          showTip(`ID ${productId}：响应数据复制成功！`, "success");
        })
        .catch(() => {
          // 降级方案：使用textarea复制
          const textarea = document.createElement("textarea");
          textarea.value = text;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
          showTip(`ID ${productId}：响应数据复制成功（降级方案）！`, "success");
        });
    } catch (error) {
      showTip(`ID ${productId}：复制失败：${error.message}`, "error");
    }
  }

  /**
   * 仅重试 actualFee（主请求已成功，只补请求 actualFee 并合并回结果）
   * @param {array} productIds 商品ID列表
   */
  async function batchRequestActualFeeOnly(productIds) {
    if (productIds.length === 0) return;
    if (batchRequestRunning) return;
    validateRequestParams();
    batchRequestRunning = true;
    showTip(`🔄 仅重试 actualFee，共 ${productIds.length} 个ID`, "success");
    if (debugBoxVisible) renderDebugBox();

    const batches = [];
    for (let i = 0; i < productIds.length; i += globalMaxConcurrent) {
      batches.push(productIds.slice(i, i + globalMaxConcurrent));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (isRateLimitedSycm && isRateLimitedTrade) break;
      const batch = batches[batchIndex];
      if (batchIndex > 0) await sleep(globalRequestInterval);

      const batchPromises = batch.map(async (productId) => {
        try {
          const actualFeeResult = await singleActualFeeRequest(productId);
          const idx = requestResults.findIndex((r) => r && r.productId === productId);
          if (idx >= 0) {
            const existing = requestResults[idx];
            requestResults[idx] = {
              ...existing,
              success: existing.success || actualFeeResult.success,
              actualFee: actualFeeResult,
              debug: {
                ...existing.debug,
                actualFeeResponse: actualFeeResult.responseText,
                actualFeeRaw: actualFeeResult.responseText,
              },
            };
          }
          renderMetrics();
          if (debugBoxVisible) renderDebugBox();
          showTip(`ID ${productId} actualFee ${actualFeeResult.success ? "成功" : "失败"}`, actualFeeResult.success ? "success" : "error");
        } catch (e) {
          showTip(`ID ${productId} actualFee 异常：${e.message}`, "error");
        }
      });
      await Promise.all(batchPromises);
    }

    batchRequestRunning = false;
    if (debugBoxVisible) renderDebugBox();
    renderMetrics();
    updateFloatRetryButton();
  }

  /**
   * 仅重试主请求（Sycm 商品指标），不请求 actualFee；合并时保留已有 actualFee
   * @param {array} productIds 商品ID列表
   */
  async function batchRequestMainOnly(productIds) {
    if (productIds.length === 0) return;
    if (batchRequestRunning) return;
    validateRequestParams();
    batchRequestRunning = true;
    showTip(`🔄 仅重试主请求，共 ${productIds.length} 个ID`, "success");
    if (debugBoxVisible) renderDebugBox();

    const batches = [];
    for (let i = 0; i < productIds.length; i += globalMaxConcurrent) {
      batches.push(productIds.slice(i, i + globalMaxConcurrent));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (isRateLimitedSycm && isRateLimitedTrade) break;
      const batch = batches[batchIndex];
      if (batchIndex > 0) await sleep(globalRequestInterval);

      const batchPromises = batch.map(async (productId) => {
        try {
          const requestResult = await singleProductRequest(productId, { skipActualFee: true });
          const existingIndex = requestResults.findIndex((r) => r && r.productId === productId);
          if (existingIndex >= 0) {
            requestResults[existingIndex] = mergeRequestResult(requestResults[existingIndex], requestResult);
          } else {
            requestResults.push(requestResult);
          }
          renderMetrics();
          if (debugBoxVisible) renderDebugBox();
          showTip(`ID ${productId} 主请求 ${requestResult.success ? "成功" : "失败"}`, requestResult.success ? "success" : "error");
        } catch (e) {
          showTip(`ID ${productId} 主请求异常：${e.message}`, "error");
        }
      });
      await Promise.all(batchPromises);
    }

    batchRequestRunning = false;
    if (debugBoxVisible) renderDebugBox();
    renderMetrics();
    updateFloatRetryButton();
  }

  /**
   * 进入/结束重新请求按钮 10 秒冷却（禁用按钮、显示倒计时）
   */
  function setRetryButtonCooldown(enterCooldown) {
    if (retryButtonCooldownTimer) {
      clearInterval(retryButtonCooldownTimer);
      retryButtonCooldownTimer = null;
    }
    const floatBtn = document.getElementById("sycm-float-retry-btn");
    const debugBtn = document.querySelector("#retry-request-btn");

    const updateCooldownText = () => {
      const left = Math.ceil((retryButtonCooldownUntil - Date.now()) / 1000);
      const text = left > 0 ? `冷却中(${left}s)` : "";
      if (floatBtn) {
        floatBtn.textContent = text || `🔄 重新请求（${getAllFailedRetryIds().length}个失败）`;
        floatBtn.disabled = left > 0;
      }
      if (debugBtn) {
        debugBtn.textContent = text || `🔄 重新请求（${getAllFailedRetryIds().length}个失败）`;
        debugBtn.disabled = left > 0;
      }
      if (left <= 0) {
        retryButtonCooldownUntil = 0;
        if (retryButtonCooldownTimer) {
          clearInterval(retryButtonCooldownTimer);
          retryButtonCooldownTimer = null;
        }
        if (floatBtn) floatBtn.disabled = false;
        if (debugBtn) debugBtn.disabled = false;
        updateFloatRetryButton();
        if (debugBoxVisible) renderDebugBox();
      }
    };

    if (enterCooldown) {
      retryButtonCooldownUntil = Date.now() + 10000;
      if (floatBtn) floatBtn.disabled = true;
      if (debugBtn) debugBtn.disabled = true;
      updateCooldownText();
      retryButtonCooldownTimer = setInterval(updateCooldownText, 1000);
    } else {
      retryButtonCooldownUntil = 0;
      if (floatBtn) floatBtn.disabled = false;
      if (debugBtn) debugBtn.disabled = false;
      updateFloatRetryButton();
    }
  }

  /**
   * 执行重新请求失败项：主请求失败只重试主请求，actualFee 失败只重试 actualFee；
   * 两个都失败时先串行重试主请求，再串行重试 actualFee；按钮 10 秒冷却
   */
  async function doRetryFailedRequests() {
    if (Date.now() < retryButtonCooldownUntil) return;

    const failedMainIds = getFailedMainRequestIds();
    const failedActualFeeIds = getFailedActualFeeIds();

    if (failedMainIds.length === 0 && failedActualFeeIds.length === 0) return;

    setRetryButtonCooldown(true);

    isRateLimited = false;
    isRateLimitedSycm = false;
    isRateLimitedTrade = false;
    requestedProductIds = requestedProductIds.filter((id) => !failedMainIds.includes(id));

    if (failedMainIds.length > 0) {
      await batchRequestMainOnly(failedMainIds);
    }
    if (failedActualFeeIds.length > 0) {
      await batchRequestActualFeeOnly(failedActualFeeIds);
    }
  }

  /**
   * 获取所有需要重试的失败 ID（主请求失败 + actualFee 失败，去重）
   */
  function getAllFailedRetryIds() {
    const mainIds = getFailedMainRequestIds();
    const feeIds = getFailedActualFeeIds();
    return [...new Set([...mainIds, ...feeIds])];
  }

  /**
   * 更新悬浮区「重新请求」按钮的显示与文案（有失败时显示在齿轮上方）
   */
  function updateFloatRetryButton() {
    const btn = document.getElementById("sycm-float-retry-btn");
    if (!btn) return;
    const failedIds = getAllFailedRetryIds();
    if (failedIds.length > 0) {
      btn.style.display = "block";
      btn.textContent = `🔄 重新请求（${failedIds.length}个失败）`;
    } else {
      btn.style.display = "none";
    }
  }

  /**
   * 创建悬浮球（用于打开/关闭调试框），上方在有失败请求时显示「重新请求」按钮
   */
  function createFloatBall() {
    let wrapper = document.getElementById("sycm-float-wrapper");
    if (wrapper) {
      updateFloatRetryButton();
      return;
    }

    wrapper = document.createElement("div");
    wrapper.id = "sycm-float-wrapper";
    wrapper.style.cssText = `
      position:fixed;
      bottom:30px;
      right:30px;
      z-index:99999998;
      display:flex;
      flex-direction:column-reverse;
      align-items:flex-end;
      gap:8px;
    `;

    // 重新请求按钮（在齿轮上方，有失败时显示）
    const retryBtn = document.createElement("button");
    retryBtn.id = "sycm-float-retry-btn";
    retryBtn.style.cssText = `
      display:none;
      background:#FF9800;
      border:none;
      color:white;
      padding:6px 12px;
      border-radius:6px;
      cursor:pointer;
      font-size:12px;
      box-shadow:0 2px 8px rgba(0,0,0,0.2);
      white-space:nowrap;
    `;
    retryBtn.textContent = "🔄 重新请求";
    retryBtn.addEventListener("click", () => {
      doRetryFailedRequests();
      updateFloatRetryButton();
      if (debugBoxVisible) renderDebugBox();
      renderMetrics();
    });
    wrapper.appendChild(retryBtn);

    // 悬浮球（齿轮）
    const floatBall = document.createElement("div");
    floatBall.id = "sycm-float-ball";
    floatBall.style.cssText = `
            width:40px;
            height:40px;
            border-radius:50%;
            background:#4CAF50;
            color:white;
            text-align:center;
            line-height:40px;
            cursor:pointer;
            box-shadow:0 2px 10px rgba(0,0,0,0.3);
            font-size:18px;
            transition:all 0.2s;
        `;

    if (isRateLimited) {
      floatBall.style.background = "#FF5722";
      floatBall.title = "请求被限制，可稍后重试或修改配置后点击重新请求";
      floatBall.textContent = "⚠️";
    } else {
      floatBall.title = "点击打开/关闭SYCM请求调试框";
      floatBall.textContent = "⚙️";
    }

    floatBall.addEventListener("mouseenter", () => {
      floatBall.style.transform = "scale(1.1)";
      floatBall.style.boxShadow = "0 4px 15px rgba(0,0,0,0.4)";
    });
    floatBall.addEventListener("mouseleave", () => {
      floatBall.style.transform = "scale(1)";
      floatBall.style.boxShadow = "0 2px 10px rgba(0,0,0,0.3)";
    });

    floatBall.addEventListener("click", () => {
      debugBoxVisible = !debugBoxVisible;
      const debugBox = document.getElementById("product-id-debug-box");
      if (debugBox) {
        debugBox.style.display = debugBoxVisible ? "block" : "none";
        if (debugBoxVisible) renderDebugBox();
      } else {
        renderDebugBox();
        debugBoxVisible = true;
      }
    });

    wrapper.appendChild(floatBall);
    document.body.appendChild(wrapper);
    updateFloatRetryButton();
  }

  /**
   * 单个商品ID的请求函数（仅主请求时可不带 actualFee）
   * @param {string} productId 商品ID
   * @param {{ skipActualFee?: boolean }} options skipActualFee=true 时只请求主接口，不请求 actualFee（用于主请求失败仅重试主请求）
   * @returns {Promise} 请求结果Promise
   */
  function singleProductRequest(productId, options = {}) {
    const skipActualFee = options.skipActualFee === true;

    if (isRateLimited) {
      const noBurstMsg = "请求太频繁被限制";
      return Promise.resolve({
        success: false,
        productId: productId,
        msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
        payAmt: { success: false, value: "", msg: noBurstMsg },
        itmUv: { success: false, value: "", msg: noBurstMsg },
        itemCartCnt: { success: false, value: "", msg: noBurstMsg },
        actualFee: skipActualFee ? undefined : { success: false, value: "", msg: noBurstMsg },
        responseText:
          '{"rgv587_flag":"sm","url":"https://bixi.alicdn.com/punish/..."}',
        debug: { error: noBurstMsg },
      });
    }

    return new Promise((resolve) => {
      const cookies = extractCookies();

      // 检查cookie2是否填写
      if (!globalCookie2 || globalCookie2.trim() === "") {
        resolve({
          success: false,
          productId: productId,
          msg: "cookie2未填写",
          payAmt: { success: false, value: "", msg: "cookie2未填写" },
          itmUv: { success: false, value: "", msg: "cookie2未填写" },
          itemCartCnt: { success: false, value: "", msg: "cookie2未填写" },
          actualFee: { success: false, value: "", msg: "cookie2未填写" }, // 新增字段
          responseText: "cookie2未填写",
          debug: { error: "cookie2未填写" },
        });
        return;
      }

      // 检查商品ID是否为空
      if (!productId) {
        resolve({
          success: false,
          productId: productId,
          msg: "产品ID为空",
          payAmt: { success: false, value: "", msg: "产品ID为空" },
          itmUv: { success: false, value: "", msg: "产品ID为空" },
          itemCartCnt: { success: false, value: "", msg: "产品ID为空" },
          actualFee: { success: false, value: "", msg: "产品ID为空" }, // 新增字段
          responseText: "产品ID为空",
          debug: { error: "产品ID为空" },
        });
        return;
      }

      try {
        const timestamp = getTimestamp();
        const dateRange = getDateRange();

        // 检查日期范围是否生成成功
        if (!dateRange) {
          resolve({
            success: false,
            productId: productId,
            msg: "日期范围生成失败",
            payAmt: { success: false, value: "", msg: "日期范围生成失败" },
            itmUv: { success: false, value: "", msg: "日期范围生成失败" },
            itemCartCnt: { success: false, value: "", msg: "日期范围生成失败" },
            actualFee: { success: false, value: "", msg: "日期范围生成失败" }, // 新增字段
            responseText: "日期范围生成失败",
            debug: { error: "日期范围生成失败" },
          });
          return;
        }

        // 构建请求参数
        const params = new URLSearchParams({
          dateRange: dateRange,
          dateType: "recent30",
          pageSize: 10,
          page: 1,
          order: "desc",
          orderBy: "payAmt",
          device: 0,
          compareType: "cycle",
          keyword: productId,
          follow: false,
          cateId: "",
          cateLevel: "",
          indexCode: "payAmt%2CsucRefundAmt%2CpayItmCnt%2CitemCartCnt%2CitmUv",
          _: timestamp,
          token: globalToken,
        });

        // 构建请求URL
        const requestUrl = `https://sycm.taobao.com/cc/item/view/top.json?${params.toString()}`;
        // 构建Cookie字符串
        const cookieStr = `cookie2=${globalCookie2}; _m_h5_tk=${cookies._m_h5_tk}; _m_h5_tk_enc=${cookies._m_h5_tk_enc};`;

        // 请求头
        const headers = {
          accept: "*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
          "bx-v": "2.5.36",
          Cookie: cookieStr,
          "onetrace-card-id":
            "sycm-cc-item-rank.%2Fcc%2Fitem_rank%7C%E6%8B%86%E5%88%86%E8%A7%86%E8%A7%92%E8%A1%A8%E6%A0%BC",
          priority: "u=1, i",
          referer: `https://sycm.taobao.com/cc/item_rank?dateRange=${dateRange}&dateType=recent30`,
          "sec-ch-ua":
            '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "sycm-referer": "/cc/item_rank",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        };

        // 发送请求
        GM_xmlhttpRequest({
          method: "GET",
          url: requestUrl,
          headers: headers,
          timeout: 10000, // 10秒超时
          onload: async (response) => {
            // 新增async
            try {
              // 检测风控数据（商品指标接口；仅标记 sycm，仍继续请求 actualFee）
              if (isRateLimitData(response.responseText, "sycm")) {
                showTip(
                  "⚠️ 商品指标请求被限制",
                  "error",
                );
                const burstMsg = response.responseText.includes("被挤爆啦") ? "被挤爆啦" : "请求太频繁被限制";
                if (!skipActualFee) {
                  const actualFeeResult = await singleActualFeeRequest(productId);
                  resolve({
                    success: false,
                    productId: productId,
                    msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
                    payAmt: { success: false, value: "", msg: burstMsg },
                    itmUv: { success: false, value: "", msg: burstMsg },
                    itemCartCnt: { success: false, value: "", msg: burstMsg },
                    actualFee: actualFeeResult,
                    responseText: response.responseText,
                    debug: { error: burstMsg, rawText: response.responseText },
                  });
                } else {
                  resolve({
                    success: false,
                    productId: productId,
                    msg: "请求太频繁被限制，关闭脚本过三四分钟再打开",
                    payAmt: { success: false, value: "", msg: burstMsg },
                    itmUv: { success: false, value: "", msg: burstMsg },
                    itemCartCnt: { success: false, value: "", msg: burstMsg },
                    actualFee: undefined,
                    responseText: response.responseText,
                    debug: { error: burstMsg, rawText: response.responseText },
                  });
                }
                renderMetrics();
                return;
              }

              const metrics = extractMetrics(response.responseText);
              let actualFeeResult = null;
              if (!skipActualFee) {
                actualFeeResult = await singleActualFeeRequest(productId);
              }

              let parsedData = {};
              let formattedResponseText = response.responseText;
              try {
                parsedData = JSON.parse(response.responseText);
                formattedResponseText = JSON.stringify(parsedData, null, 2);
              } catch (error) {
                showTip(`ID ${productId}：JSON解析失败`, "error");
              }

              resolve({
                success: true,
                productId: productId,
                msg: skipActualFee
                  ? `请求成功，状态码：${response.status} | ${metrics.payAmt.msg} | ${metrics.itmUv.msg} | ${metrics.itemCartCnt.msg}`
                  : `请求成功，状态码：${response.status} | ${metrics.payAmt.msg} | ${metrics.itmUv.msg} | ${metrics.itemCartCnt.msg} | ${actualFeeResult.msg}`,
                payAmt: metrics.payAmt,
                itmUv: metrics.itmUv,
                itemCartCnt: metrics.itemCartCnt,
                actualFee: skipActualFee ? undefined : actualFeeResult,
                responseText: formattedResponseText,
                debug: {
                  url: requestUrl,
                  dateRange: dateRange,
                  timestamp: `${timestamp}（毫秒级）`,
                  cookie2: globalCookie2,
                  status: response.status,
                  rawText: response.responseText,
                  parsedData: JSON.stringify(parsedData, null, 2),
                  actualFeeResponse: skipActualFee ? undefined : actualFeeResult.responseText,
                  actualFeeRaw: skipActualFee ? undefined : actualFeeResult.rawText,
                },
              });
            } catch (error) {
              resolve({
                success: false,
                productId: productId,
                msg: `请求成功但处理失败：${error.message}`,
                payAmt: { success: false, value: "", msg: `处理失败：${error.message}` },
                itmUv: { success: false, value: "", msg: `处理失败：${error.message}` },
                itemCartCnt: { success: false, value: "", msg: `处理失败：${error.message}` },
                actualFee: skipActualFee ? undefined : { success: false, value: "", msg: `处理失败：${error.message}` },
                responseText: error.message,
                debug: { error: error.message },
              });
            }
          },
          onerror: (error) => {
            resolve({
              success: false,
              productId: productId,
              msg: `请求失败：${error.message || "网络错误"}`,
              payAmt: { success: false, value: "", msg: "请求失败，无法提取支付金额" },
              itmUv: { success: false, value: "", msg: "请求失败，无法提取访客数" },
              itemCartCnt: { success: false, value: "", msg: "请求失败，无法提取加购件数" },
              actualFee: skipActualFee ? undefined : { success: false, value: "", msg: "请求失败，无法提取actualFee" },
              responseText: error.message || "网络错误",
              debug: { error: error.message || "网络错误" },
            });
          },
          ontimeout: () => {
            resolve({
              success: false,
              productId: productId,
              msg: "请求超时（10秒）",
              payAmt: { success: false, value: "", msg: "请求超时，无法提取支付金额" },
              itmUv: { success: false, value: "", msg: "请求超时，无法提取访客数" },
              itemCartCnt: { success: false, value: "", msg: "请求超时，无法提取加购件数" },
              actualFee: skipActualFee ? undefined : { success: false, value: "", msg: "请求超时，无法提取actualFee" },
              responseText: "请求超时（10秒）",
              debug: { error: "请求超时（10秒）" },
            });
          },
        });
      } catch (error) {
        resolve({
          success: false,
          productId: productId,
          msg: `请求异常：${error.message}`,
          payAmt: { success: false, value: "", msg: "请求异常，无法提取支付金额" },
          itmUv: { success: false, value: "", msg: "请求异常，无法提取访客数" },
          itemCartCnt: { success: false, value: "", msg: "请求异常，无法提取加购件数" },
          actualFee: skipActualFee ? undefined : { success: false, value: "", msg: "请求异常，无法提取actualFee" },
          responseText: error.message,
          debug: { error: error.message },
        });
      }
    });
  }

  /**
   * 批量请求商品数据（支持并发配置）
   * @param {array} productIds 商品ID列表
   */
  /**
   * 合并请求结果：新结果中被限制/失败字段不覆盖旧结果中的成功数据
   * @param {object} existing 已有结果（可能含部分成功）
   * @param {object} newResult 本次请求结果
   * @returns {object} 合并后的结果
   */
  function mergeRequestResult(existing, newResult) {
    if (!existing || !newResult || existing.productId !== newResult.productId) {
      return newResult;
    }
    const keepOldIfNewFailed = (oldField, newField) => {
      if (newField && newField.success) return newField;
      if (oldField && oldField.success) return oldField;
      return newField || oldField;
    };
    return {
      ...newResult,
      success: newResult.success || existing.success,
      payAmt: keepOldIfNewFailed(existing.payAmt, newResult.payAmt),
      itmUv: keepOldIfNewFailed(existing.itmUv, newResult.itmUv),
      itemCartCnt: keepOldIfNewFailed(existing.itemCartCnt, newResult.itemCartCnt),
      actualFee: keepOldIfNewFailed(existing.actualFee, newResult.actualFee),
      msg: newResult.msg || existing.msg,
      responseText: newResult.responseText || existing.responseText,
      debug: newResult.debug || existing.debug,
    };
  }

  async function batchRequestProductData(productIds) {
    // 仅当两个接口都被限制时才不再发起请求
    if (isRateLimitedSycm && isRateLimitedTrade) {
      showTip("⚠️ 请求被限制，可稍后重试或修改配置后点击重新请求", "error");
      return;
    }

    // 校验请求参数
    validateRequestParams();

    // 检查是否正在运行或无ID
    if (batchRequestRunning || productIds.length === 0) return;

    // 初始化请求状态
    batchRequestRunning = true;
    concurrentStatus = {
      total: productIds.length,
      completed: 0,
      success: 0,
      failed: 0,
    };

    // 显示启动提示
    showTip(
      `🚀 启动请求！共${productIds.length}个ID | 并发数：${globalMaxConcurrent} | 间隔：${globalRequestInterval}ms`,
      "success",
    );
    if (debugBoxVisible) renderDebugBox();

    // 分批次处理请求（按并发数分组）
    const batches = [];
    for (let i = 0; i < productIds.length; i += globalMaxConcurrent) {
      batches.push(productIds.slice(i, i + globalMaxConcurrent));
    }

    // 遍历每个批次
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      // 仅当两个接口都被限制时才终止批次，否则另一个接口继续请求
      if (isRateLimitedSycm && isRateLimitedTrade) break;

      const batch = batches[batchIndex];
      // 非第一个批次，等待指定间隔
      if (batchIndex > 0) await sleep(globalRequestInterval);

      // 执行当前批次的请求（并行）
      const batchPromises = batch.map(async (productId) => {
        try {
          const requestResult = await singleProductRequest(productId);
          // 合并结果：被限制时保留之前请求成功的数据，不覆盖
          const existingIndex = requestResults.findIndex(
            (r) => r && r.productId === productId
          );
          if (existingIndex >= 0) {
            requestResults[existingIndex] = mergeRequestResult(
              requestResults[existingIndex],
              requestResult
            );
          } else {
            requestResults.push(requestResult);
          }
          // 记录已请求的ID
          if (!requestedProductIds.includes(productId)) {
            requestedProductIds.push(productId);
          }
          // 更新状态统计
          concurrentStatus.completed++;
          if (requestResult.success) {
            concurrentStatus.success++;
          } else {
            concurrentStatus.failed++;
          }
          // 重新渲染指标和调试框
          renderMetrics();
          if (debugBoxVisible) renderDebugBox();
          // 显示进度提示
          showTip(
            `ID ${productId} ${requestResult.success ? "请求成功" : "请求失败"}（${concurrentStatus.completed}/${concurrentStatus.total}）`,
            requestResult.success ? "success" : "error",
          );
        } catch (error) {
          // 异常处理
          concurrentStatus.completed++;
          concurrentStatus.failed++;
          showTip(`ID ${productId} 请求异常：${error.message}`, "error");
        }
      });

      // 等待当前批次所有请求完成
      await Promise.all(batchPromises);
    }

    // 批量请求完成
    batchRequestRunning = false;
    // 非全风控状态显示完成提示
    if (!(isRateLimitedSycm && isRateLimitedTrade)) {
      showTip(
        `✅ 请求完成！总${concurrentStatus.total}个 | 成功${concurrentStatus.success}个 | 失败${concurrentStatus.failed}个`,
        "success",
      );
    }
    // 刷新调试框和指标
    if (debugBoxVisible) renderDebugBox();
    renderMetrics();
  }

  /**
   * 自动请求新的商品ID数据
   * @param {array} targetIds 指定的商品ID列表（可选）
   */
  function autoRequestNewProducts(targetIds = []) {
    // 仅当两个接口都被限制时才不再请求
    if (isRateLimitedSycm && isRateLimitedTrade) {
      showTip("⚠️ 请求被限制，可稍后重试或修改配置后点击重新请求", "error");
      return;
    }

    // 校验参数
    validateRequestParams();

    // 获取要请求的ID列表
    const productIds = targetIds.length > 0 ? targetIds : getNewProductIds();

    // 无新ID
    if (productIds.length === 0) {
      showTip("暂无新增ID，无需请求", "success");
      return;
    }

    // 未填写cookie2
    if (!globalCookie2 || globalCookie2.trim() === "") {
      showTip("请先填写cookie2参数！", "error");
      return;
    }

    // 启动批量请求
    batchRequestProductData(productIds);
  }

  /**
   * 监听页面ID变化，自动请求新ID
   */
  function watchProductIdsChange() {
    let lastProductIds = [];
    // 监听目标节点（商品ID所在区域）
    const targetNode =
      document.querySelector(".product-desc-span")?.parentNode || document.body;

    // 创建观察者
    const observer = new MutationObserver(() => {
      // 防抖处理：1秒内只处理一次
      clearTimeout(window.observerDebounce);
      window.observerDebounce = setTimeout(() => {
        // 获取当前ID列表（风控时仍更新界面，自动请求由 autoRequestNewProducts 在双限时拦截）
        const currentIds = extractProductIds().ids;
        // ID列表变化时处理
        if (JSON.stringify(currentIds) !== JSON.stringify(lastProductIds)) {
          lastProductIds = [...currentIds];
          // 重新渲染指标
          renderMetrics();
          // 获取新ID并自动请求
          const newIds = getNewProductIds();
          if (newIds.length > 0 && globalCookie2 && !batchRequestRunning) {
            autoRequestNewProducts(newIds);
          }
        }
      }, 1000);
    });

    // 启动观察者
    observer.observe(targetNode, {
      childList: true,
      subtree: true,
      characterData: false,
    });

    // 页面卸载时断开观察者
    window.addEventListener("beforeunload", () => {
      observer.disconnect();
    });
  }

  /**
   * 渲染调试框
   */
  function renderDebugBox() {
    if (!debugBoxVisible) return;

    try {
      let debugBox = document.getElementById("product-id-debug-box");
      // 创建调试框（如果不存在）
      if (!debugBox) {
        debugBox = document.createElement("div");
        debugBox.id = "product-id-debug-box";
        debugBox.style.cssText = `
                    position:fixed;
                    top:20px;
                    right:20px;
                    background:rgba(0,0,0,0.95);
                    color:#fff;
                    padding:15px;
                    border-radius:8px;
                    font-size:13px;
                    font-family:Arial;
                    z-index:9999999;
                    border:1px solid #666;
                    min-width:300px;
                    max-height:80vh;
                    overflow-y:auto;
                    box-shadow:0 0 15px rgba(0,0,0,0.7);
                    display:block;
                `;
        document.body.appendChild(debugBox);
        debugBoxCreated = true;
      }

      // 获取基础数据
      const cookies = extractCookies();
      const productIdData = extractProductIds();
      const newIdCount = getNewProductIds().length;
      // 折叠按钮样式
      const foldButtonStyle = `
                background:none;
                border:none;
                color:#4CAF50;
                cursor:pointer;
                font-size:11px;
                margin-left:8px;
                padding:0;
                vertical-align:middle;
            `;

      // 构建状态提示（被限制时仅提示，不禁用脚本）
      let statusHtml = "";
      if (isRateLimited) {
        statusHtml = `<div style="color:#FF5722;font-size:11px;margin-bottom:8px;font-weight:bold;">⚠️ 请求太频繁被限制，请稍后再试。可修改下方配置后点击「重新请求」</div>`;
      }
      statusHtml += batchRequestRunning
        ? `<div style="color:#4CAF50;font-size:11px;margin-bottom:8px;">🚦 请求中 | 并发数：${globalMaxConcurrent} | 间隔：${globalRequestInterval}ms | 进度：${concurrentStatus.completed}/${concurrentStatus.total} | 成功：${concurrentStatus.success} | 失败：${concurrentStatus.failed}</div>`
        : `<div style="color:${newIdCount > 0 ? "#FF9800" : "#4CAF50"};font-size:11px;margin-bottom:8px;">🚦 无运行批次 | 待请求新增ID：${newIdCount} | 并发数：${globalMaxConcurrent} | 间隔：${globalRequestInterval}ms</div>`;

      // 被限制时也不禁用输入框，用户可改配置后重试
      const inputDisabled = "";

      // 构建配置输入框
      const configHtml = `
                <div style="margin:3px 0;padding:5px;background:#222;border-radius:3px;">
                    <label style="color:#8BC34A;font-weight:bold;">必填 · cookie2：</label>
                    <input type="text" id="cookie2-input" ${inputDisabled} placeholder="请输入cookie2值" style="width:60%;padding:3px;margin-left:10px;border:1px solid #444;background:#1a1a1a;color:#fff;border-radius:3px;font-size:11px;" value="${globalCookie2}">
                </div>
                <div style="margin:3px 0;padding:5px;background:#222;border-radius:3px;display:flex;gap:10px;align-items:center;">
                    <div>
                        <label style="color:#FFC107;font-weight:bold;">并发数量：</label>
                        <input type="number" id="concurrent-input" ${inputDisabled} min="1" max="20" placeholder="1" style="width:60px;padding:3px;border:1px solid #444;background:#1a1a1a;color:#fff;border-radius:3px;font-size:11px;" value="${globalMaxConcurrent}">
                        <span style="color:#999;font-size:10px;">(上限20)</span>
                    </div>
                    <div>
                        <label style="color:#FFC107;font-weight:bold;">请求间隔(ms)：</label>
                        <input type="number" id="interval-input" ${inputDisabled} min="100" placeholder="500" style="width:80px;padding:3px;border:1px solid #444;background:#1a1a1a;color:#fff;border-radius:3px;font-size:11px;" value="${globalRequestInterval}">
                        <span style="color:#999;font-size:10px;">(最小100)</span>
                    </div>
                </div>
                <div style="margin:3px 0;padding:4px 6px;background:#332200;border-radius:3px;color:#FFB74D;font-size:11px;line-height:1.4;">
                    如果修改请求速度，有概率会触发平台风控，若触发风控请关闭此脚本过几分钟再打开
                </div>
            `;

      // 获取需要重试的失败 ID（主请求或 actualFee 失败）
      const failedIds = getAllFailedRetryIds();
      const hasFailedRequests = failedIds.length > 0;

      // 构建重新请求按钮
      const retryButtonHtml = hasFailedRequests
        ? `<button id="retry-request-btn" style="background:#FF9800;border:none;color:white;padding:5px 10px;border-radius:3px;cursor:pointer;margin:5px 0;">🔄 重新请求（${failedIds.length}个失败）</button>`
        : "";

      // 构建Cookie面板
      const cookiePanel = `
                <div style="margin:8px 0;">
                    ${statusHtml}
                    ${retryButtonHtml}
                    <div style="font-weight:bold;margin-bottom:5px;color;">🍪 配置参数：</div>
                    ${configHtml}
                    <div style="margin:3px 0;padding:2px 5px;background:#222;border-radius:3px;">
                        <span style="color:#999;">_m_h5_tk：</span>
                        <span style="color:#2196F3;font-weight:bold;">${cookies._m_h5_tk || "未找到该Cookie"}</span>
                    </div>
                    <div style="margin:3px 0;padding:2px 5px;background:#222;border-radius:3px;">
                        <span style="color:#999;">_m_h5_tk_enc：</span>
                        <span style="color:#2196F3;font-weight:bold;">${cookies._m_h5_tk_enc || "未找到该Cookie"}</span>
                    </div>
                </div>
            `;

      // ID列表折叠按钮
      const idFoldButton = `<button id="fold-ids-btn" style="${foldButtonStyle}">${foldState.ids ? "展开" : "收起"}</button>`;

      // 构建ID列表（新增actualFee展示；被限制时仍显示列表，不替换为提示）
      let idListHtml = "";
      idListHtml =
          productIdData.ids.length > 0
            ? productIdData.ids
                .map((productId) => {
                  const payAmt = getPayAmt(productId);
                  const visitorCount = getVisitorCount(productId);
                  const cartCount = getCartCount(productId);
                  const actualFee = getActualFee(productId); // 新增actualFee
                  const isRequested = requestedProductIds.includes(productId);
                  // 判断是否有有效数据（包含actualFee）
                  const hasValidData =
                    (payAmt !== "待请求" && payAmt !== "暂无数据" && payAmt !== "请求失败") ||
                    (visitorCount !== "待请求" && visitorCount !== "暂无数据" && visitorCount !== "请求失败") ||
                    (cartCount !== "待请求" && cartCount !== "暂无数据" && cartCount !== "请求失败") ||
                    (actualFee !== "待请求" && actualFee !== "暂无数据" && actualFee !== "请求失败");
                  const textColor = hasValidData ? "#4CAF50" : "#FF5722";

                  return `
                            <div style="margin:3px 0;padding:2px 5px;background:#222;border-radius:3px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;">
                                <div>
                                    <span style="color:#999;">ID：</span>
                                    <span style="color:#4CAF50;font-weight:bold;">${productId}</span>
                                    ${isRequested ? '<span style="color:#8BC34A;font-size:10px;margin-left:5px;">(已请求)</span>' : ""}
                                </div>
                                <div style="display:flex;gap:10px;margin-top:4px;width:100%;flex-wrap:wrap;">
                                    <span style="color:${textColor};font-size:11px;">支付金额：<strong>${payAmt}</strong></span>
                                    <span style="color:${textColor};font-size:11px;">访客数：<strong>${visitorCount}</strong></span>
                                    <span style="color:${textColor};font-size:11px;">加购件数：<strong>${cartCount}</strong></span>
                                    <span style="color:${textColor};font-size:11px;">实收款<strong>${actualFee}</strong></span> <!-- 新增actualFee -->
                                </div>
                            </div>
                        `;
                })
                .join("")
            : `<div style="color:#FF9800;margin:5px 0;">${productIdData.msg}</div>`;

      // 构建ID面板
      const idPanel = `
                <div style="margin:8px 0;">
                    <div style="font-weight:bold;margin-bottom:5px;color:#fff;">📌 提取的产品ID ${idFoldButton}</div>
                    <div id="ids-content" style="display:${foldState.ids ? "none" : "block"};">${idListHtml}</div>
                </div>
            `;

      // 单条结果卡片 HTML（供成功/失败列表共用，index 为在 requestResults 中的下标，用于复制）
      const buildResultCard = (result, index) => {
        const textColor = result.success ? "#4CAF50" : "#FF5722";
        const icon = result.success ? "✅" : "❌";
        const metricsHtml = `
                                <div style="margin:5px 0;padding:5px;background:#1a1a1a;border-radius:3px;">
                                    <div style="color:#FFC107;font-size:11px;margin-bottom:3px;"><strong>🎯 数据提取结果：</strong></div>
                                    <div style="font-size:11px;color:${result.payAmt && result.payAmt.success ? "#4CAF50" : "#FF5722"};">支付金额：${result.payAmt ? result.payAmt.msg : "-"}</div>
                                    <div style="font-size:11px;color:${result.itmUv && result.itmUv.success ? "#4CAF50" : "#FF5722"};">访客数：${result.itmUv ? result.itmUv.msg : "-"}</div>
                                    <div style="font-size:11px;color:${result.itemCartCnt && result.itemCartCnt.success ? "#4CAF50" : "#FF5722"};">加购件数：${result.itemCartCnt ? result.itemCartCnt.msg : "-"}</div>
                                    <div style="font-size:11px;color:${result.actualFee && result.actualFee.success ? "#4CAF50" : "#FF5722"};">实收款：${result.actualFee ? result.actualFee.msg : "-"}</div>
                                    ${result.payAmt && result.payAmt.value ? `<div style="font-size:12px;color:#fff;margin-top:2px;">支付金额值：<strong>${formatNumber(result.payAmt.value)}</strong></div>` : ""}
                                    ${result.itmUv && result.itmUv.value ? `<div style="font-size:12px;color:#fff;margin-top:2px;">访客数值：<strong>${result.itmUv.value}</strong></div>` : ""}
                                    ${result.itemCartCnt && result.itemCartCnt.value ? `<div style="font-size:12px;color:#fff;margin-top:2px;">加购件数值：<strong>${result.itemCartCnt.value}</strong></div>` : ""}
                                </div>`;
        const copyButton = `<button class="copy-response-btn" data-idx="${index}" style="background:#2196F3;border:none;color:white;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px;margin-left:10px;">复制响应数据</button>`;
        return `
                                <div style="margin:8px 0;padding:8px;background:#222;border-radius:3px;border-left:3px solid ${textColor};">
                                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;flex-wrap:wrap;">
                                        <span style="font-weight:bold;color:${textColor};">${icon} ID：${result.productId}</span>
                                        <div style="margin-top:3px;">
                                            <span style="font-size:10px;color:#999;">${new Date().toLocaleTimeString()}</span>
                                            ${copyButton}
                                        </div>
                                    </div>
                                    <div style="font-size:11px;color:#ccc;margin-bottom:5px;word-wrap:break-word;">${result.msg}</div>
                                    ${result.debug && result.debug.url ? `<div style="font-size:10px;color:#aaa;margin:3px 0;word-wrap:break-word;">• URL：<code style="word-wrap:break-word;">${result.debug.url.substring(0, 80)}...</code></div>` : ""}
                                    ${result.debug && result.debug.timestamp ? `<div style="font-size:10px;color:#aaa;margin:3px 0;">• 时间戳：${result.debug.timestamp}</div>` : ""}
                                    ${result.debug && result.debug.dateRange ? `<div style="font-size:10px;color:#aaa;margin:3px 0;">• dateRange：${result.debug.dateRange}</div>` : ""}
                                    ${metricsHtml}
                                    ${result.actualFee && result.actualFee.value && result.actualFee.value.length > 0 ? `
                                    <div style="margin:5px 0;padding:5px;background:#1a1a1a;border-radius:3px;">
                                        <div style="color:#FF9800;font-size:11px;margin-bottom:3px;"><strong>💰 主订单actualFee详细：</strong></div>
                                        <div style="font-size:10px;color:#fff;line-height:1.4;">
                                            ${result.actualFee.value.map((order, i) => `
                                                <div style="margin-bottom:3px;padding:2px 4px;background:#222;border-radius:2px;">
                                                    <div><strong>订单${i + 1}：</strong>${order.orderId}</div>
                                                    <div><strong>实收款：</strong>¥${order.realTotal}</div>
                                                    <div><strong>订单时间：</strong>${order.orderTime}</div>
                                                    <div><strong>订单状态：</strong>${order.orderStatus}</div>
                                                </div>
                                            `).join('')}
                                        </div>
                                    </div>
                                    ` : ""}
                                    <div style="margin:5px 0;padding:5px;background:#1a1a1a;border-radius:3px;">
                                        <div style="color:#8BC34A;font-size:11px;margin-bottom:3px;">基础响应数据：</div>
                                        <pre style="margin:0;padding:3px;background:#000;border-radius:2px;color:#8BC34A;font-size:10px;max-height:100px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;">${result.responseText || (result.debug && (result.debug.parsedData || result.debug.rawText || result.debug.error)) || "无"}</pre>
                                    </div>
                                    ${result.debug && result.debug.actualFeeResponse ? `
                                    <div style="margin:5px 0;padding:5px;background:#1a1a1a;border-radius:3px;">
                                        <div style="color:#FF9800;font-size:11px;margin-bottom:3px;">actualFee请求响应：</div>
                                        <pre style="margin:0;padding:3px;background:#000;border-radius:2px;color:#FF9800;font-size:10px;max-height:100px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;">${result.debug.actualFeeResponse || "无"}</pre>
                                    </div>
                                    ` : ""}
                                </div>`;
      };

      const successList = requestResults.map((r, i) => ({ result: r, index: i })).filter((x) => x.result.success);
      const failedList = requestResults.map((r, i) => ({ result: r, index: i })).filter((x) => !x.result.success);
      const successFoldBtn = `<button id="fold-results-success-btn" style="${foldButtonStyle}">${foldState.resultsSuccess ? "展开" : "收起"}</button>`;
      const failedFoldBtn = `<button id="fold-results-failed-btn" style="${foldButtonStyle}">${foldState.resultsFailed ? "展开" : "收起"}</button>`;
      const successListHtml = successList.length > 0
        ? successList.map((x) => buildResultCard(x.result, x.index)).join("")
        : `<div style="color:#999;font-size:11px;margin:5px 0;">暂无成功结果</div>`;
      const failedListHtml = failedList.length > 0
        ? failedList.map((x) => buildResultCard(x.result, x.index)).join("")
        : `<div style="color:#999;font-size:11px;margin:5px 0;">暂无失败结果</div>`;

      const resultPanel = `
                <div style="margin:8px 0;">
                    <div style="font-weight:bold;margin-bottom:5px;color:#fff;">📡 请求成功结果（${successList.length}条）${successFoldBtn}</div>
                    <div id="results-success-content" style="display:${foldState.resultsSuccess ? "none" : "block"};">${successListHtml}</div>
                </div>
                <div style="margin:8px 0;">
                    <div style="font-weight:bold;margin-bottom:5px;color:#fff;">📡 请求失败结果（${failedList.length}条）${failedFoldBtn}</div>
                    <div id="results-failed-content" style="display:${foldState.resultsFailed ? "none" : "block"};">${failedListHtml}</div>
                </div>
            `;

      // 构建调试框完整HTML（添加宽度限制和横向滚动）
      const debugBoxHtml = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid #444;padding-bottom:5px;flex-wrap:wrap;">
                    <span style="font-weight:bold;color:#4CAF50;">近30天商品访客数/加购件数/支付金额+近3个月订单自动获取 --Ace</span>
                    <span style="font-size:11px;color:#999;">${new Date().toLocaleTimeString()}</span>
                </div>
                ${cookiePanel}
                <div style="height:1px;background:#444;margin:10px 0;"></div>
                ${idPanel}
                <div style="height:1px;background:#444;margin:10px 0;"></div>
                ${resultPanel}
                <button id="debug-box-close" style="background:#333;border:none;color:#ccc;padding:4px 10px;border-radius:3px;cursor:pointer;margin-top:10px;width:100%;">关闭</button>
            `;

      // 更新调试框内容（添加宽度限制和溢出控制）
      debugBox.style.width = "98%"; // 限制最大宽度为页面98%
      debugBox.style.maxWidth = "500px"; // 设定最大宽度上限
      debugBox.style.overflowX = "auto"; // 横向溢出时显示滚动条
      debugBox.style.boxSizing = "border-box"; // 内边距不影响宽度计算
      debugBox.innerHTML = debugBoxHtml;

      // 恢复滚动位置
      if (debugBoxScrollTop > 0) {
        debugBox.scrollTop = debugBoxScrollTop;
      }

      // 绑定关闭按钮事件
      const closeButton = debugBox.querySelector("#debug-box-close");
      if (!closeButton.dataset.bound) {
        closeButton.dataset.bound = "true";
        closeButton.onclick = () => {
          debugBoxVisible = false;
          debugBox.style.display = "none";
          debugBoxScrollTop = debugBox.scrollTop;
        };
      }

      // 绑定cookie2输入框事件
      const cookieInput = debugBox.querySelector("#cookie2-input");
      if (!cookieInput.dataset.bound) {
        cookieInput.dataset.bound = "true";
        cookieInput.addEventListener("focus", () => {
          cookieInputFocused = true;
        });
        cookieInput.addEventListener("blur", () => {
          cookieInputFocused = false;
        });
        cookieInput.addEventListener("input", () => {
          globalCookie2 = cookieInput.value.trim();
          batchRequestRunning = false;
          // 自动请求新ID
          const newIds = getNewProductIds();
          if (newIds.length > 0 && !batchRequestRunning) {
            autoRequestNewProducts(newIds);
          }
        });
      }
      // 保持输入框聚焦
      if (cookieInputFocused) {
        setTimeout(() => cookieInput.focus(), 0);
      }

      // 绑定并发数输入框事件
      const concurrentInput = debugBox.querySelector("#concurrent-input");
      if (!concurrentInput.dataset.bound) {
        concurrentInput.dataset.bound = "true";
        concurrentInput.addEventListener("change", () => {
          globalMaxConcurrent = concurrentInput.value.trim();
          validateRequestParams(); // 校验并修正
          concurrentInput.value = globalMaxConcurrent; // 同步修正后的值
          renderDebugBox(); // 刷新调试框
        });
      }

      // 绑定请求间隔输入框事件
      const intervalInput = debugBox.querySelector("#interval-input");
      if (!intervalInput.dataset.bound) {
        intervalInput.dataset.bound = "true";
        intervalInput.addEventListener("change", () => {
          globalRequestInterval = intervalInput.value.trim();
          validateRequestParams(); // 校验并修正
          intervalInput.value = globalRequestInterval; // 同步修正后的值
          renderDebugBox(); // 刷新调试框
        });
      }

      // 绑定ID列表折叠按钮事件
      const idFoldButtonEl = debugBox.querySelector("#fold-ids-btn");
      if (!idFoldButtonEl.dataset.bound) {
        idFoldButtonEl.dataset.bound = "true";
        idFoldButtonEl.onclick = () => {
          foldState.ids = !foldState.ids;
          renderDebugBox();
        };
      }

      // 绑定「请求成功结果」折叠按钮
      const resultSuccessFoldEl = debugBox.querySelector("#fold-results-success-btn");
      if (resultSuccessFoldEl && !resultSuccessFoldEl.dataset.bound) {
        resultSuccessFoldEl.dataset.bound = "true";
        resultSuccessFoldEl.onclick = () => {
          foldState.resultsSuccess = !foldState.resultsSuccess;
          renderDebugBox();
        };
      }
      // 绑定「请求失败结果」折叠按钮
      const resultFailedFoldEl = debugBox.querySelector("#fold-results-failed-btn");
      if (resultFailedFoldEl && !resultFailedFoldEl.dataset.bound) {
        resultFailedFoldEl.dataset.bound = "true";
        resultFailedFoldEl.onclick = () => {
          foldState.resultsFailed = !foldState.resultsFailed;
          renderDebugBox();
        };
      }

      // 绑定复制按钮事件
      debugBox.querySelectorAll(".copy-response-btn").forEach((button) => {
        if (!button.dataset.bound) {
          button.dataset.bound = "true";
          button.onclick = () => {
            const index = parseInt(button.getAttribute("data-idx"));
            const result = requestResults[index];
            // 复制基础响应+actualFee响应
            const copyText = `基础响应：\n${result.responseText || result.debug.rawText || ""}\n\nactualFee响应：\n${result.debug.actualFeeResponse || "无"}`;
            copyTextToClipboard(copyText, result.productId);
          };
        }
      });

      // 绑定重新请求按钮事件（与悬浮区重试共用逻辑）
      const retryButton = debugBox.querySelector("#retry-request-btn");
      if (retryButton && !retryButton.dataset.bound) {
        retryButton.dataset.bound = "true";
        retryButton.onclick = () => {
          doRetryFailedRequests();
          updateFloatRetryButton();
          renderDebugBox();
        };
      }

      // 绑定滚动事件（记录滚动位置）
      if (!debugBox.dataset.scrollBound) {
        debugBox.dataset.scrollBound = "true";
        debugBox.onscroll = () => {
          debugBoxScrollTop = debugBox.scrollTop;
        };
      }
    } catch (error) {
      console.warn("调试框渲染失败：", error);
    }
  }

  /**
   * 初始化脚本
   */
  function initScript() {
    setTimeout(() => {
      try {
        // 校验初始化参数
        validateRequestParams();
        // 创建悬浮球
        createFloatBall();
        // 初始渲染指标
        renderMetrics();
        // 监听ID变化
        watchProductIdsChange();
        // 允许批量请求
        batchRequestRunning = false;
      } catch (error) {
        console.warn("脚本初始化失败：", error);
      }
    }, 500);
  }

  // 页面加载完成后初始化
  if (document.readyState === "complete") {
    initScript();
  } else {
    window.addEventListener("load", initScript);
  }
})();
