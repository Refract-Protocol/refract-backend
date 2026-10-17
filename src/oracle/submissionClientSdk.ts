import { createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  serializeCanonicalSubmissionPayload,
  type SignedSubmissionPayload,
  type SubmissionVerificationResult,
} from "./submissionVerifier.ts";

export interface ProviderSdkConfig {
  providerId: string;
  privateKeyPem: string;
  submitTransport: (
    payload: SignedSubmissionPayload
  ) => Promise<SubmissionVerificationResult> | SubmissionVerificationResult;
}

export class ProviderSubmissionClient {
  private readonly providerId: string;
  private readonly privateKeyPem: string;
  private readonly submitTransport: ProviderSdkConfig["submitTransport"];

  constructor(config: ProviderSdkConfig) {
    this.providerId = config.providerId;
    this.privateKeyPem = config.privateKeyPem;
    this.submitTransport = config.submitTransport;
  }

  public buildSignedPayload(params: {
    coverageType: string;
    value: number;
    unit: string;
    observedAtMs: number;
    nonce?: string;
  }): SignedSubmissionPayload {
    const nonce = params.nonce ?? randomBytes(12).toString("hex");
    const unsignedPayload = {
      providerId: this.providerId,
      coverageType: params.coverageType,
      value: params.value,
      unit: params.unit,
      observedAtMs: params.observedAtMs,
      nonce,
    };

    const canonical = serializeCanonicalSubmissionPayload(unsignedPayload);
    const privKey = createPrivateKey(this.privateKeyPem);
    const signatureBuf = sign(null, Buffer.from(canonical, "utf8"), privKey);

    return {
      ...unsignedPayload,
      signatureBase64: signatureBuf.toString("base64"),
    };
  }

  public async submitReading(params: {
    coverageType: string;
    value: number;
    unit: string;
    observedAtMs: number;
    nonce?: string;
  }): Promise<SubmissionVerificationResult> {
    const signedPayload = this.buildSignedPayload(params);
    return await this.submitTransport(signedPayload);
  }
}
