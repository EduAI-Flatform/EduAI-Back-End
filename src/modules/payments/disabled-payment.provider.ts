import {
  CreatePaymentRequestInput,
  CreatedPaymentRequest,
  PaymentProvider,
  PaymentProviderError,
  PaymentRequestStatus,
  VerifiedPaymentWebhook,
  VerifyPaymentWebhookInput,
} from './payment-provider';

export class DisabledPaymentProvider implements PaymentProvider {
  createPaymentRequest(_input: CreatePaymentRequestInput): Promise<CreatedPaymentRequest> {
    return this.disabled();
  }

  retrievePaymentRequest(_identity: string): Promise<PaymentRequestStatus> {
    return this.disabled();
  }

  cancelPaymentRequest(_identity: string, _reason?: string): Promise<PaymentRequestStatus> {
    return this.disabled();
  }

  verifyWebhook(_input: VerifyPaymentWebhookInput): Promise<VerifiedPaymentWebhook> {
    return this.disabled();
  }

  reconcilePaymentRequest(_identity: string): Promise<PaymentRequestStatus> {
    return this.disabled();
  }

  private disabled<T>(): Promise<T> {
    return Promise.reject(new PaymentProviderError('disabled', false));
  }
}
