import { z } from "zod";

export const US_STATES: { code: string; name: string }[] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"],
  ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"],
  ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"],
  ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"],
  ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"],
  ["UM", "U.S. Minor Outlying Islands"],
  ["AA", "Armed Forces Americas"], ["AE", "Armed Forces Europe"],
  ["AP", "Armed Forces Pacific"],
].map(([code, name]) => ({ code, name }));

const stateCodes = new Set(US_STATES.map(({ code }) => code));
export const patientAddressFields = z.object({
  address: z.string().trim().max(500).default(""),
  address_unit: z.string().trim().max(100).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().transform((value) => value.toUpperCase())
    .refine((value) => value === "" || stateCodes.has(value),
      "Select a valid U.S. state, territory, or military address code")
    .default(""),
  zip_code: z.string().trim()
    .refine((value) => value === "" || /^\d{5}(-\d{4})?$/.test(value),
      "Enter a five-digit ZIP code or ZIP+4")
    .default(""),
});

type PatientAddress = {
  address?: string;
  address_unit?: string;
  city?: string;
  state?: string;
  zip_code?: string;
};

export function formatPatientAddress(patient: PatientAddress): string {
  const locality = [patient.city, [patient.state, patient.zip_code]
    .filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [patient.address, patient.address_unit, locality]
    .filter(Boolean).join(", ");
}
