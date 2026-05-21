declare const signedUrlBrand: unique symbol;

export type SignedUrl = string & {
  readonly [signedUrlBrand]: "SignedUrl";
};

export function signedUrl(value: string): SignedUrl {
  return value as SignedUrl;
}

export function redactedSignedUrl(_value: SignedUrl) {
  void _value;
  return "<signed-url-redacted>";
}
