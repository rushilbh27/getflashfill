import { extractOTP, extractLink } from './src/shared/otp-extractor.ts';

const text1 = `
Welcome to Emergent!

Please verify your email address by clicking the link below:
https://app.emergent.sh/verify?token=123456789

© 2024 Emergent Inc.
`;

console.log('OTP 1:', extractOTP(text1));
console.log('Link 1:', extractLink(text1));

const text2 = `
Verify your login
Your code is 12345

Click here: https://example.com/magic
`;

console.log('OTP 2:', extractOTP(text2));
console.log('Link 2:', extractLink(text2));
