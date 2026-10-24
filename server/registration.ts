type PatientRow = Record<string, any>;
const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
export function matchingPatients(
  rows: PatientRow[],
  input: { first_name: string; last_name: string; dob: string },
) {
  return rows
    .filter(
      (p) =>
        p.dob === input.dob &&
        normalized(p.first_name) === normalized(input.first_name) &&
        normalized(p.last_name) === normalized(input.last_name),
    )
    .map(({ id, first_name, last_name, dob, phone }) => ({
      id,
      first_name,
      last_name,
      dob,
      phone,
    }));
}
