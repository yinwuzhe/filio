package app.folio.reader;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypted configuration; encryption keys never leave AndroidKeyStore. */
public final class TranslationStore implements TranslationService.ConfigStore {
    private static final int MAGIC = 0x464F4C31;
    private static final int IV_BYTES = 12;
    private static final int MAX_BYTES = 64 * 1024;
    private static final byte[] AAD = "Folio translation configuration v1".getBytes(StandardCharsets.UTF_8);
    private final AtomicFile file;
    private final String keyAlias;

    public TranslationStore(Context context) {
        Context application = context.getApplicationContext();
        file = new AtomicFile(new File(application.getNoBackupFilesDir(), "translation-config.enc"));
        keyAlias = application.getPackageName() + ".translation-config.v1";
    }

    @Override
    public synchronized JSONObject load() throws Exception {
        byte[] encrypted;
        try (FileInputStream input = file.openRead();
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) {
                if (output.size() + count > MAX_BYTES) {
                    throw new GeneralSecurityException("Invalid encrypted configuration size");
                }
                output.write(chunk, 0, count);
            }
            encrypted = output.toByteArray();
        } catch (FileNotFoundException error) {
            if (file.getBaseFile().exists() || sibling(".bak").exists()) throw error;
            return null;
        }
        if (encrypted.length < 4 + IV_BYTES + 16) {
            throw new GeneralSecurityException("Invalid encrypted configuration");
        }
        ByteBuffer buffer = ByteBuffer.wrap(encrypted);
        if (buffer.getInt() != MAGIC) throw new GeneralSecurityException("Unknown configuration version");
        byte[] iv = new byte[IV_BYTES];
        buffer.get(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(AAD);
        byte[] plaintext = cipher.doFinal(encrypted, 4 + IV_BYTES, encrypted.length - 4 - IV_BYTES);
        try {
            return new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    @Override
    public synchronized void save(JSONObject configuration) throws Exception {
        if (configuration == null) throw new IllegalArgumentException("Missing configuration");
        byte[] plaintext = configuration.toString().getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        byte[] iv;
        try {
            if (plaintext.length > MAX_BYTES - 4 - IV_BYTES - 16) {
                throw new GeneralSecurityException("Configuration too large");
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(AAD);
            iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("Invalid encryption IV");
            encrypted = cipher.doFinal(plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
        byte[] envelope = ByteBuffer.allocate(4 + IV_BYTES + encrypted.length)
                .putInt(MAGIC).put(iv).put(encrypted).array();
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(envelope);
            file.finishWrite(output);
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw error;
        }
    }

    @Override
    public synchronized void clear() throws Exception {
        file.delete();
        if (file.getBaseFile().exists() || sibling(".bak").exists() || sibling(".new").exists()) {
            throw new GeneralSecurityException("Cannot remove encrypted configuration");
        }
        KeyStore store = keyStore();
        if (store.containsAlias(keyAlias)) store.deleteEntry(keyAlias);
    }

    private File sibling(String suffix) {
        return new File(file.getBaseFile().getPath() + suffix);
    }

    private KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private SecretKey key(boolean allowCreation) throws Exception {
        KeyStore store = keyStore();
        if (store.containsAlias(keyAlias)) {
            java.security.Key existing = store.getKey(keyAlias, null);
            if (!(existing instanceof SecretKey)) throw new GeneralSecurityException("Invalid encryption key");
            return (SecretKey) existing;
        }
        if (!allowCreation) throw new GeneralSecurityException("Encryption key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(keyAlias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
