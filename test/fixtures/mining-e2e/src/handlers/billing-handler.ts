/** mining-e2e fixture — billing handler(遵守 wrapResult 约定的样本 3)。 */
import { type Result, wrapResult } from '../shared/result.js';

interface Invoice {
  orderId: string;
  amount: number;
  issuedAt: string;
}

const invoices: Invoice[] = [];

export function issueInvoice(orderId: string, amount: number): Result<Invoice> {
  return wrapResult(() => {
    if (amount <= 0) {
      throw new Error('invoice amount must be positive');
    }
    const invoice = { orderId, amount, issuedAt: new Date().toISOString() };
    invoices.push(invoice);
    return invoice;
  });
}

export function listInvoices(): Result<Invoice[]> {
  return wrapResult(() => invoices.slice());
}
