import { useState } from 'react';
import type { Policy } from '../server/finance-engine';

export const insuranceDate = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
    new Date(),
  );
export function PolicyFields({
  policy,
  prefix = '',
  subscriberFromPatient = false,
}: {
  policy?: Partial<Policy>;
  prefix?: string;
  subscriberFromPatient?: boolean;
}) {
  const field = (name: string) => `${prefix}${name}`;
  return (
    <>
      <label>
        Coverage priority
        <select
          name={field('priority')}
          defaultValue={policy?.priority || 'Primary'}
        >
          <option>Primary</option>
          <option>Secondary</option>
        </select>
      </label>
      <label>
        Payer name
        <input
          name={field('payer')}
          defaultValue={policy?.payer}
          required
          maxLength={200}
          placeholder="Demo Health Plan"
        />
      </label>
      <label>
        Plan name
        <input
          name={field('plan')}
          defaultValue={policy?.plan}
          required
          maxLength={200}
        />
      </label>
      <label>
        Member ID
        <input
          name={field('member_id')}
          defaultValue={policy?.member_id}
          required
          minLength={2}
          maxLength={80}
        />
      </label>
      <label>
        Group number
        <input
          name={field('group_number')}
          defaultValue={policy?.group_number}
          maxLength={80}
        />
      </label>
      {subscriberFromPatient ? (
        <input type="hidden" name={field('relationship')} value="Self" />
      ) : (
        <>
          <label>
            Subscriber name
            <input
              name={field('subscriber_name')}
              defaultValue={policy?.subscriber_name}
              required
              maxLength={200}
            />
          </label>
          <label>
            Subscriber date of birth
            <input
              type="date"
              name={field('subscriber_dob')}
              defaultValue={policy?.subscriber_dob}
              required
              max={insuranceDate()}
            />
          </label>
          <label>
            Patient relationship
            <select
              name={field('relationship')}
              defaultValue={policy?.relationship || 'Self'}
            >
              {['Self', 'Spouse', 'Child', 'Other'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <label>
        Effective date
        <input
          type="date"
          name={field('effective_date')}
          defaultValue={
            policy?.effective_date || `${insuranceDate().slice(0, 4)}-01-01`
          }
          required
        />
      </label>
      <label>
        Coverage end date
        <input
          type="date"
          name={field('end_date')}
          defaultValue={policy?.end_date}
        />
        <small>Optional for ongoing coverage</small>
      </label>
    </>
  );
}
export function RegistrationInsuranceFields({
  onEnabledChange,
}: {
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [subscriber, setSubscriber] = useState(true);
  const [verify, setVerify] = useState(false);
  return (
    <section className="registration-insurance span-2">
      <h3>Insurance & billing</h3>
      <p className="finance-help">
        Capture coverage now and manage claims and payments in the patient
        record after a visit.
      </p>
      <label className="finance-check">
        <input
          type="checkbox"
          name="add_insurance"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            onEnabledChange?.(e.target.checked);
          }}
        />
        Add insurance during registration
      </label>
      {enabled && (
        <>
          <label className="finance-check">
            <input
              type="checkbox"
              name="patient_is_subscriber"
              checked={subscriber}
              onChange={(e) => setSubscriber(e.target.checked)}
            />
            Patient is the subscriber
          </label>
          <div className="form-grid">
            <PolicyFields
              prefix="insurance_"
              subscriberFromPatient={subscriber}
            />
          </div>
          <label className="finance-check">
            <input
              type="checkbox"
              name="verify_insurance"
              checked={verify}
              onChange={(e) => setVerify(e.target.checked)}
            />
            Run a demo coverage check now
          </label>
          {verify && (
            <div className="form-grid">
              <label>
                Verification service date
                <input
                  type="date"
                  name="insurance_service_date"
                  defaultValue={insuranceDate()}
                  required
                />
              </label>
              <label>
                Demo response
                <select name="insurance_scenario">
                  <option>Active</option>
                  <option>Inactive</option>
                  <option>Needs review</option>
                </select>
              </label>
            </div>
          )}
          <p className="finance-help">
            Payer connection is in demo mode. The saved patient record opens to
            Insurance after registration. Billing starts from an encounter; no
            charges are created during registration.
          </p>
        </>
      )}
    </section>
  );
}
