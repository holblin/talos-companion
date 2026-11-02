//! Versioned recovery envelopes. V2 is a tar stream inside passphrase-encrypted age.
use std::io::{Read, Write};

pub const MAGIC_V2: &[u8; 9] = b"TCBACKUP\x02";
// Fixed KDF cost bounds memory independently of file size (scrypt uses about 64 MiB).
const SCRYPT_WORK_FACTOR: u8 = 16;

pub fn encrypt<W: Write>(
    mut output: W,
    passphrase: &str,
) -> anyhow::Result<age::stream::StreamWriter<W>> {
    output.write_all(MAGIC_V2)?;
    let mut recipient =
        age::scrypt::Recipient::new(age::secrecy::SecretString::from(passphrase.to_owned()));
    recipient.set_work_factor(SCRYPT_WORK_FACTOR);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
    Ok(encryptor.wrap_output(output)?)
}

pub fn decrypt<R: Read + 'static>(mut input: R, passphrase: &str) -> anyhow::Result<Box<dyn Read>> {
    let mut magic = [0; 9];
    input.read_exact(&mut magic)?;
    match &magic {
        MAGIC_V2 => {
            let decryptor = age::Decryptor::new(input)?;
            anyhow::ensure!(
                decryptor.is_scrypt(),
                "Recovery file is not passphrase encrypted"
            );
            let mut identity =
                age::scrypt::Identity::new(age::secrecy::SecretString::from(passphrase.to_owned()));
            identity.set_max_work_factor(SCRYPT_WORK_FACTOR);
            Ok(Box::new(decryptor.decrypt(std::iter::once(
                &identity as &dyn age::Identity,
            ))?))
        }
        _ => anyhow::bail!("Unsupported recovery format"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    const PASS: &str = "test-only long recovery passphrase";

    #[test]
    fn stream_rejects_wrong_password_corruption_and_truncation() {
        let mut data = Vec::new();
        let mut writer = encrypt(&mut data, PASS).unwrap();
        io::copy(&mut io::repeat(42).take(200_000), &mut writer).unwrap();
        writer.finish().unwrap();
        let mut reader = decrypt(io::Cursor::new(data.clone()), PASS).unwrap();
        assert_eq!(io::copy(&mut reader, &mut io::sink()).unwrap(), 200_000);
        assert!(decrypt(io::Cursor::new(data.clone()), "wrong password").is_err());
        let mut truncated =
            decrypt(io::Cursor::new(data[..data.len() - 16].to_vec()), PASS).unwrap();
        assert!(io::copy(&mut truncated, &mut io::sink()).is_err());
        let last = data.len() - 1;
        data[last] ^= 1;
        let mut damaged = decrypt(io::Cursor::new(data), PASS).unwrap();
        assert!(io::copy(&mut damaged, &mut io::sink()).is_err());
    }
}
