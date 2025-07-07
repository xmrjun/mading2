"use strict";
const axios = require('axios');
const crypto = require('crypto');
const qs = require('qs');

const BACKOFF_EXPONENT = 1.5;
const DEFAULT_TIMEOUT_MS = 5000;
const BASE_URL = "https://api.backpack.exchange/";

// 执行对应操作的命令
const instructions = {
  public: new Map([
    ["assets", { url: `${BASE_URL}api/v1/assets`, method: "GET" }],
    ["markets", { url: `${BASE_URL}api/v1/markets`, method: "GET" }],
    ["ticker", { url: `${BASE_URL}api/v1/ticker`, method: "GET" }],
    ["depth", { url: `${BASE_URL}api/v1/depth`, method: "GET" }],
    ["klines", { url: `${BASE_URL}api/v1/klines`, method: "GET" }],
    ["status", { url: `${BASE_URL}api/v1/status`, method: "GET" }],
    ["ping", { url: `${BASE_URL}api/v1/ping`, method: "GET" }],
    ["time", { url: `${BASE_URL}api/v1/time`, method: "GET" }],
    ["trades", { url: `${BASE_URL}api/v1/trades`, method: "GET" }],
    ["tradesHistory", { url: `${BASE_URL}api/v1/trades/history`, method: "GET" }],
  ]),
  private: new Map([
    ["balanceQuery", { url: `${BASE_URL}api/v1/capital`, method: "GET" }],
    ["depositAddressQuery", { url: `${BASE_URL}wapi/v1/capital/deposit/address`, method: "GET" }],
    ["depositQueryAll", { url: `${BASE_URL}wapi/v1/capital/deposits`, method: "GET" }],
    ["fillHistoryQueryAll", { url: `${BASE_URL}wapi/v1/history/fills`, method: "GET" }],
    ["orderCancel", { url: `${BASE_URL}api/v1/order`, method: "DELETE" }],
    ["orderCancelAll", { url: `${BASE_URL}api/v1/orders`, method: "DELETE" }],
    ["orderExecute", { url: `${BASE_URL}api/v1/order`, method: "POST" }],
    ["orderHistoryQueryAll", { url: `${BASE_URL}wapi/v1/history/orders`, method: "GET" }],
    ["orderQuery", { url: `${BASE_URL}api/v1/order`, method: "GET" }],
    ["orderQueryAll", { url: `${BASE_URL}api/v1/orders`, method: "GET" }],
    ["withdraw", { url: `${BASE_URL}wapi/v1/capital/withdrawals`, method: "POST" }],
    ["withdrawalQueryAll", { url: `${BASE_URL}wapi/v1/capital/withdrawals`, method: "GET" }],
  ]),
};

// 解码私钥成pkcs8编码的私钥 因为crypto.sign需要的私钥格式是pkcs8格式
const toPkcs8der = (rawB64) => {
  var rawPrivate = Buffer.from(rawB64, "base64").subarray(0, 32);
  var prefixPrivateEd25519 = Buffer.from("302e020100300506032b657004220420", "hex");
  var der = Buffer.concat([prefixPrivateEd25519, rawPrivate]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
};

// 解码公钥成spki编码的公钥 因为crypto.verify需要的公钥格式是spki格式
const toSpki = (rawB64) => {
  var rawPublic = Buffer.from(rawB64, "base64");
  var prefixPublicEd25519 = Buffer.from("302a300506032b6570032100", "hex");
  var der = Buffer.concat([prefixPublicEd25519, rawPublic]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
};

/**
 * 生成签名方法 getMessageSignature
 * @param  {Object}        request params as an object
 * @param  {string}        privateKey
 * @param  {number}        timestamp Unix time in ms that the request was sent
 * @param  {string}        instruction
 * @param  {number}        window Time window in milliseconds that the request is valid for
 * @return {string}        base64 encoded signature to include on request
 */
const getMessageSignature = (request, privateKey, timestamp, instruction, window) => {
  function alphabeticalSort(a, b) {
    return a.localeCompare(b);
  }
  const message = qs.stringify(request, { sort: alphabeticalSort });
  const headerInfo = { timestamp, window: window ?? DEFAULT_TIMEOUT_MS };
  const headerMessage = qs.stringify(headerInfo);
  const messageToSign = "instruction=" + instruction + "&" + (message ? message + "&" : "") + headerMessage;
  const signature = crypto.sign(null, Buffer.from(messageToSign), toPkcs8der(privateKey));
  return signature.toString("base64");
};

// 请求方法 rawRequest(命令，请求头，请求参数)
const rawRequest = async (instruction, headers, data) => {
  const { url, method } = instructions.private.has(instruction)
    ? instructions.private.get(instruction)
    : instructions.public.get(instruction);
  let fullUrl = url;
  headers["User-Agent"] = "Backpack NodeJS API Client";
  headers["Content-Type"] = method == "GET" ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8";
  
  const options = {
    method,
    url: fullUrl,
    headers,
    timeout: 30000,
  };
  
  if (method == "GET") {
    if (Object.keys(data).length > 0) {
      options.url = url + "?" + qs.stringify(data);
    }
  } else if (method == "POST" || method == "DELETE") {
    options.data = data;
  }
  
  try {
    const response = await axios(options);
    const contentType = response.headers["content-type"];
    
    if (contentType?.includes("application/json")) {
      const parsed = response.data;
      if (parsed.error && parsed.error.length) {
        const error = parsed.error.filter((e) => e.startsWith("E")).map((e) => e.substr(1));
        if (!error.length) {
          throw new Error("Backpack API returned an unknown error");
        }
        throw new Error(`url=${url} body=${JSON.stringify(data)} err=${error.join(", ")}`);
      }
      return parsed;
    } else if (contentType?.includes("text/plain")) {
      return response.data;
    } else {
      return response.data;
    }
  } catch (error) {
    if (error.response) {
      throw new Error(`API请求失败: ${error.response.status} - ${error.response.data?.message || error.response.statusText}`);
    } else if (error.request) {
      throw new Error('网络请求失败，请检查网络连接');
    } else {
      throw new Error(`请求配置错误: ${error.message}`);
    }
  }
};

/**
 * BackpackClient connects to the Backpack API
 * @param {string} privateKey base64 encoded
 * @param {string} publicKey  base64 encoded
 */
class BackpackClient {
  constructor(privateKey, publicKey) {
    this.config = { privateKey, publicKey };
    
    // 验证密钥对是否匹配
    try {
      const pubkeyFromPrivateKey = crypto
        .createPublicKey(toPkcs8der(privateKey))
        .export({ format: "der", type: "spki" })
        .toString("base64");
      const pubkey = toSpki(publicKey)
        .export({ format: "der", type: "spki" })
        .toString("base64");
      
      if (pubkeyFromPrivateKey != pubkey) {
        throw new Error("错误的秘钥对，请检查私钥公钥是否匹配");
      }
    } catch (error) {
      throw new Error(`密钥验证失败: ${error.message}`);
    }
  }

  /**
   * 发送公共或私有API请求
   * @param  {String}   method   方法名 The API method (public or private)
   * @param  {Object}   params   Arguments to pass to the api call
   * @param  {Number}   retrysLeft 重试请求的次数
   * @return {Object}   The response object
   */
  async api(method, params, retrysLeft = 10) {
    try {
      if (instructions.public.has(method)) {
        return await this.publicMethod(method, params);
      } else if (instructions.private.has(method)) {
        return await this.privateMethod(method, params);
      }
    } catch (e) {
      if (retrysLeft > 0) {
        const numTry = 11 - retrysLeft;
        const backOff = Math.pow(numTry, BACKOFF_EXPONENT);
        console.warn("BPX api error", { method, numTry, backOff }, e.toString());
        await new Promise((resolve) => setTimeout(resolve, backOff * 1000));
        return await this.api(method, params, retrysLeft - 1);
      } else {
        throw e;
      }
    }
    throw new Error(method + " is not a valid API method.");
  }

  /**
   * 发送公共API请求
   * @param  {String}   instruction   The API method (public or private)
   * @param  {Object}   params        Arguments to pass to the api call
   * @return {Object}                 The response object
   */
  async publicMethod(instruction, params = {}) {
    const response = await rawRequest(instruction, {}, params);
    return response;
  }

  /**
   * 发送私有API请求
   * @param  {String}   instruction The API method (public or private)
   * @param  {Object}   params      Arguments to pass to the api call
   * @return {Object}               The response object
   */
  async privateMethod(instruction, params = {}) {
    const timestamp = Date.now();
    const signature = getMessageSignature(params, this.config.privateKey, timestamp, instruction);
    const headers = {
      "X-Timestamp": timestamp,
      "X-Window": this.config.timeout ?? DEFAULT_TIMEOUT_MS,
      "X-API-Key": this.config.publicKey,
      "X-Signature": signature,
    };
    const response = await rawRequest(instruction, headers, params);
    return response;
  }

  // API方法封装
  async Balance() {
    return this.api("balanceQuery");
  }

  async Deposits(params) {
    return this.api("depositQueryAll", params);
  }

  async DepositAddress(params) {
    return this.api("depositAddressQuery", params);
  }

  async Withdrawals(params) {
    return this.api("withdrawalQueryAll", params);
  }

  async Withdraw(params) {
    return this.api("withdraw", params);
  }

  async OrderHistory(params) {
    return this.api("orderHistoryQueryAll", params);
  }

  async FillHistory(params) {
    return this.api("fillHistoryQueryAll", params);
  }

  async Assets() {
    return this.api("assets");
  }

  async Markets() {
    return this.api("markets");
  }

  async Ticker(params) {
    return this.api("ticker", params);
  }

  async Depth(params) {
    return this.api("depth", params);
  }

  async KLines(params) {
    return this.api("klines", params);
  }

  async GetOrder(params) {
    return this.api("orderQuery", params);
  }

  async ExecuteOrder(params) {
    return this.api("orderExecute", params, 0);
  }

  async CancelOrder(params) {
    return this.api("orderCancel", params);
  }

  async GetOpenOrders(params) {
    return this.api("orderQueryAll", params);
  }

  async CancelOpenOrders(params) {
    return this.api("orderCancelAll", params);
  }

  async Status() {
    return this.api("status");
  }

  async Ping() {
    return this.api("ping");
  }

  async Time() {
    return this.api("time");
  }

  async RecentTrades(params) {
    return this.api("trades", params);
  }

  async HistoricalTrades(params) {
    return this.api("tradesHistory", params);
  }
}

module.exports = { BackpackClient };