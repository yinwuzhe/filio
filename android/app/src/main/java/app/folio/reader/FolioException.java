package app.folio.reader;

public class FolioException extends Exception {
    public final String code;

    public FolioException(String message, String code) {
        super(message);
        this.code = code;
    }
}
