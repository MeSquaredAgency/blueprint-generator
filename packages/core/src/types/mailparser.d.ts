// The parts of mailparser's API the ingest stage uses. mailparser ships no
// types and @types/mailparser isn't a dependency the plan names.
declare module "mailparser" {
  export interface EmailAddress {
    name: string;
    address?: string;
  }
  export interface AddressObject {
    value: EmailAddress[];
    text: string;
  }
  export interface ParsedMail {
    from?: AddressObject;
    to?: AddressObject | AddressObject[];
    cc?: AddressObject | AddressObject[];
    subject?: string;
    text?: string;
    headerLines: { key: string; line: string }[];
  }
  export function simpleParser(source: Uint8Array | string): Promise<ParsedMail>;
}
