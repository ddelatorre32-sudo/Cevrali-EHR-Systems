# Full clinical launch: service connections

The requested launch includes charting, scheduling, prescribing, billing, fax, and results. Hosting and reviews have been reported ready; their provider, HTTPS address, and approval references have not yet been supplied for verification. No external healthcare or delivery providers have been arranged. This is a record of the current setup, not an approval for clinical use.

The existing code implements simulated external workflows. Removing the production startup block would not connect them to pharmacies, payers, laboratories, or fax recipients. Real-patient use remains disabled.

| Connection needed for the requested launch | Current implementation | Required implementation and verification |
| --- | --- | --- |
| E-prescribing, including controlled medications | Prescription drafts and simulated signing; no pharmacy or EPCS transport | Select a contracted prescribing service, implement its API and acknowledgments, and complete its prescriber enrollment and applicable EPCS requirements. Account authenticator MFA does not replace the prescribing service's required authorization. |
| Laboratories and radiology results | Local order/result review and transcription; no live delivery | Select the actual facilities or interface service; implement their supported interfaces, patient/order matching, result corrections, acknowledgments, and failure handling. Verify results and abnormal-result escalation with the practice. |
| Insurance eligibility and claims/remittance | Demo coverage checks, claim submission, decisions, and remittance | Select a payer/clearinghouse service; implement and test its eligibility, submission, acknowledgment, correction, and remittance workflows. Workers compensation routing and authorization must follow the actual carriers' supported processes. |
| Electronic fax | Simulated outbox and incoming-document processing | Select the fax service; implement authenticated send/receive callbacks, delivery status, original-document retrieval, retries, duplicates, and patient-matching review. A simulated delivery is not proof of a sent fax. |
| SMS and email reminders | Reminder preferences and simulated delivery | Select delivery services; implement consent-aware delivery, failures, opt-outs, and duplicate suppression. Internal staff chat does not establish an external SMS/email connection. |

Provider names, API documentation, and non-secret account identifiers can be used for implementation. Production credentials, signing material, and callback secrets belong in the hosting platform's protected secret manager; do not put them in chat, source control, or ordinary practice preferences. Verify the applicable agreements and allowed data handling with the practice's privacy/security owners.

After services are selected, adapters must be implemented against those services and tested using synthetic data before configuring production delivery. Retain evidence for successful delivery, rejected requests, corrections, retries, duplicates, reconciliation, and downtime. Record actual reviewer decisions against the resulting release; do not convert the pending approval template into approvals without that evidence.

The deployed site can then be inspected with the read-only [deployment checker](DEPLOYMENT-VERIFICATION.md). A passing site check establishes only the properties it probes. It does not prove clinical safety, regulatory compliance, vendor connectivity, backup recovery, or the truth of review attestations.
