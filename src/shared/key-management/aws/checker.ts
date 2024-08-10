import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import axios, { AxiosError, AxiosRequestConfig, AxiosHeaders } from "axios";
import { URL } from "url";
import { KeyCheckerBase } from "../key-checker-base";
import type { AwsBedrockKey, AwsBedrockKeyProvider } from "./provider";
import { getAwsBedrockModelFamily } from "../../models";
import { config } from "../../../config";

const KNOWN_MODEL_IDS = [
  "anthropic.claude-v2",
  "anthropic.claude-3-sonnet-20240229-v1:0",
  "anthropic.claude-3-haiku-20240307-v1:0",
  "anthropic.claude-3-opus-20240229-v1:0",
  "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "mistral.mistral-7b-instruct-v0:2",
  "mistral.mixtral-8x7b-instruct-v0:1",
  "mistral.mistral-large-2402-v1:0",
  "mistral.mistral-large-2407-v1:0",
  "mistral.mistral-small-2402-v1:0",
];
const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 90 * 60 * 1000; // 90 minutes
const AMZ_HOST =
  process.env.AMZ_HOST || "bedrock-runtime.%REGION%.amazonaws.com";
const GET_CALLER_IDENTITY_URL = `https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`;
const GET_INVOCATION_LOGGING_CONFIG_URL = (region: string) =>
  `https://bedrock.${region}.amazonaws.com/logging/modelinvocations`;
const POST_INVOKE_MODEL_URL = (region: string, model: string) =>
  `https://${AMZ_HOST.replace("%REGION%", region)}/model/${model}/invoke`;
const TEST_MESSAGES = [
  { role: "user", content: "Hi!" },
  { role: "assistant", content: "Hello!" },
];

type AwsError = { error: {} };

type GetLoggingConfigResponse = {
  loggingConfig: null | {
    cloudWatchConfig: null | unknown;
    s3Config: null | unknown;
    embeddingDataDeliveryEnabled: boolean;
    imageDataDeliveryEnabled: boolean;
    textDataDeliveryEnabled: boolean;
  };
};

type UpdateFn = typeof AwsBedrockKeyProvider.prototype.update;

export class AwsKeyChecker extends KeyCheckerBase<AwsBedrockKey> {
  constructor(keys: AwsBedrockKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "aws",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: AwsBedrockKey) {
    const isInitialCheck = !key.lastChecked;

    if (isInitialCheck) {
      const checks = await Promise.all(
        KNOWN_MODEL_IDS.map(async (model) => {
          const success = await this.invokeModel(model, key);
          return { model, success };
        })
      );
      const modelIds = checks
        .filter(({ success }) => success)
        .map(({ model }) => model);

      if (modelIds.length === 0) {
        this.log.warn(
          { key: key.hash },
          "Key does not have access to any models; disabling."
        );
        return this.updateKey(key.hash, { isDisabled: true });
      }

      this.updateKey(key.hash, {
        modelIds,
        modelFamilies: Array.from(
          new Set(modelIds.map(getAwsBedrockModelFamily))
        ),
      });
    }

    this.log.debug(
      {
        key: key.hash,
        logged: key.awsLoggingStatus,
        families: key.modelFamilies,
        models: key.modelIds,
      },
      "Checked key."
    );
  }

  protected handleAxiosError(key: AwsBedrockKey, error: AxiosError) {
    if (error.response && AwsKeyChecker.errorIsAwsError(error)) {
      const errorHeader = error.response.headers["x-amzn-errortype"] as string;
      const errorType = errorHeader.split(":")[0];
      switch (errorType) {
        case "AccessDeniedException":
          // Indicates that the principal's attached policy does not allow them
          // to perform the requested action.
          // How we handle this depends on whether the action was one that we
          // must be able to perform in order to use the key.
          const path = new URL(error.config?.url!).pathname;
          const data = error.response.data;
          this.log.warn(
            { key: key.hash, type: errorType, path, data },
            "Key can't perform a required action; disabling."
          );
          return this.updateKey(key.hash, { isDisabled: true });
        case "UnrecognizedClientException":
          // This is a 403 error that indicates the key is revoked.
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is revoked; disabling."
          );
          return this.updateKey(key.hash, {
            isDisabled: true,
            isRevoked: true,
          });
        case "ThrottlingException":
          // This is a 429 error that indicates the key is rate-limited, but
          // not necessarily disabled. Retry in 10 seconds.
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is rate limited. Rechecking in 10 seconds."
          );
          const next = Date.now() - (KEY_CHECK_PERIOD - 10 * 1000);
          return this.updateKey(key.hash, { lastChecked: next });
        case "ValidationException":
        default:
          // This indicates some issue that we did not account for, possibly
          // a new ValidationException type. This likely means our key checker
          // needs to be updated so we'll just let the key through and let it
          // fail when someone tries to use it if the error is fatal.
          this.log.error(
            { key: key.hash, errorType, error: error.response.data },
            "Encountered unexpected error while checking key. This may indicate a change in the API; please report this."
          );
          return this.updateKey(key.hash, { lastChecked: Date.now() });
      }
    }
    const { response } = error;
    const { headers, status, data } = response ?? {};
    this.log.error(
      { key: key.hash, status, headers, data, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  /**
   * Attempt to invoke the given model with the given key.  Returns true if the
   * key has access to the model, false if it does not. Throws an error if the
   * key is disabled.
   */
  private async invokeModel(
    model: string,
    key: AwsBedrockKey
  ): Promise<boolean> {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    // This is not a valid invocation payload, but a 400 response indicates that
    // the principal at least has permission to invoke the model.
    // A 403 response indicates that the model is not accessible -- if none of
    // the models are accessible, the key is effectively disabled.
    const payload = {
      max_tokens: -1,
      messages: TEST_MESSAGES,
      anthropic_version: "bedrock-2023-05-31",
    };
    const config: AxiosRequestConfig = {
      method: "POST",
      url: POST_INVOKE_MODEL_URL(creds.region, model),
      data: payload,
      validateStatus: (status) => [400, 403, 404].includes(status),
    };
    config.headers = new AxiosHeaders({
      "content-type": "application/json",
      accept: "*/*",
    });
    await AwsKeyChecker.signRequestForAws(config, key);
    const response = await axios.request(config);
    const { data, status, headers } = response;
    const errorType = (headers["x-amzn-errortype"] as string).split(":")[0];
    const errorMessage = data?.message;

    // We only allow one type of 403 error, and we only allow it for one model.
    if (
      status === 403 &&
      errorMessage?.match(/access to the model with the specified model ID/)
    ) {
      return false;
    }

    // ResourceNotFound typically indicates that the tested model cannot be used
    // on the configured region for this set of credentials.
    if (status === 404) {
      this.log.debug(
        { region: creds.region, model, key: key.hash },
        "Model not supported in this AWS region."
      );
      return false;
    }

    // We're looking for a specific error type and message here
    // "ValidationException"
    const correctErrorType = errorType === "ValidationException";
    const correctErrorMessage = errorMessage?.match(/max_tokens/);
    if (!correctErrorType || !correctErrorMessage) {
      return false;
    }

    this.log.debug(
      { key: key.hash, model, errorType, data, status },
      "AWS InvokeModel test successful."
    );
    return true;
  }

  private async checkLoggingConfiguration(key: AwsBedrockKey) {
    if (config.allowAwsLogging) {
      // Don't check logging status if we're allowing it to reduce API calls.
      this.updateKey(key.hash, { awsLoggingStatus: "unknown" });
      return true;
    }

    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    const req: AxiosRequestConfig = {
      method: "GET",
      url: GET_INVOCATION_LOGGING_CONFIG_URL(creds.region),
      headers: { accept: "application/json" },
      validateStatus: () => true,
    };
    await AwsKeyChecker.signRequestForAws(req, key);
    const { data, status, headers } =
      await axios.request<GetLoggingConfigResponse>(req);

    let result: AwsBedrockKey["awsLoggingStatus"] = "unknown";

    if (status === 200) {
      const { loggingConfig } = data;
      const loggingEnabled = !!loggingConfig?.textDataDeliveryEnabled;
      this.log.debug(
        { key: key.hash, loggingConfig, loggingEnabled },
        "AWS model invocation logging test complete."
      );
      result = loggingEnabled ? "enabled" : "disabled";
    } else {
      const errorType = (headers["x-amzn-errortype"] as string).split(":")[0];
      this.log.debug(
        { key: key.hash, errorType, data, status },
        "Can't determine AWS model invocation logging status."
      );
    }

    this.updateKey(key.hash, { awsLoggingStatus: result });
    return !!result;
  }

  static errorIsAwsError(error: AxiosError): error is AxiosError<AwsError> {
    const headers = error.response?.headers;
    if (!headers) return false;
    return !!headers["x-amzn-errortype"];
  }

  /** Given an Axios request, sign it with the given key. */
  static async signRequestForAws(
    axiosRequest: AxiosRequestConfig,
    key: AwsBedrockKey,
    awsService = "bedrock"
  ) {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    const { accessKeyId, secretAccessKey, region } = creds;
    const { method, url: axUrl, headers: axHeaders, data } = axiosRequest;
    const url = new URL(axUrl!);

    let plainHeaders = {};
    if (axHeaders instanceof AxiosHeaders) {
      plainHeaders = axHeaders.toJSON();
    } else if (typeof axHeaders === "object") {
      plainHeaders = axHeaders;
    }

    const request = new HttpRequest({
      method,
      protocol: "https:",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { Host: url.hostname, ...plainHeaders },
    });

    if (data) {
      request.body = JSON.stringify(data);
    }

    const signer = new SignatureV4({
      sha256: Sha256,
      credentials: { accessKeyId, secretAccessKey },
      region,
      service: awsService,
    });
    const signedRequest = await signer.sign(request);
    axiosRequest.headers = signedRequest.headers;
  }

  static getCredentialsFromKey(key: AwsBedrockKey) {
    const [accessKeyId, secretAccessKey, region] = key.key.split(":");
    if (!accessKeyId || !secretAccessKey || !region) {
      throw new Error("Invalid AWS Bedrock key");
    }
    return { accessKeyId, secretAccessKey, region };
  }
}
