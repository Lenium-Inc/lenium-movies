package me.streamvy.movies;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_WRITE_STORAGE = 4201;

    private static final class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType;
        }
    }

    private PendingDownload pendingDownload;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setDownloadListener(
                (url, userAgent, contentDisposition, mimeType, contentLength) ->
                    requestDownload(url, userAgent, contentDisposition, mimeType)
            );
        }
    }

    private void requestDownload(
        String url,
        String userAgent,
        String contentDisposition,
        String mimeType
    ) {
        if (url == null || url.startsWith("blob:") || url.startsWith("data:")) {
            Toast.makeText(this, "This download cannot be saved", Toast.LENGTH_SHORT).show();
            return;
        }

        if (
            Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
        ) {
            pendingDownload = new PendingDownload(url, userAgent, contentDisposition, mimeType);
            ActivityCompat.requestPermissions(
                this,
                new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE },
                REQUEST_WRITE_STORAGE
            );
            return;
        }

        enqueueDownload(url, userAgent, contentDisposition, mimeType);
    }

    private void enqueueDownload(
        String url,
        String userAgent,
        String contentDisposition,
        String mimeType
    ) {
        try {
            String absoluteUrl = url.startsWith("/") ? "https://www.streamvy.me" + url : url;
            String safeMime = mimeType == null || mimeType.isEmpty()
                ? "application/octet-stream"
                : mimeType;
            String fileName = URLUtil.guessFileName(absoluteUrl, contentDisposition, safeMime);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(absoluteUrl));
            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            request.setMimeType(safeMime);
            request.setTitle(fileName);
            request.setDescription("Downloading from Stream Vy");
            request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager manager =
                (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                Toast.makeText(this, "Download manager unavailable", Toast.LENGTH_SHORT).show();
                return;
            }
            manager.enqueue(request);
            Toast.makeText(this, "Download started", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            Toast.makeText(this, "Download failed to start", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        @NonNull String[] permissions,
        @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_WRITE_STORAGE) return;

        PendingDownload download = pendingDownload;
        pendingDownload = null;
        if (
            download != null &&
            grantResults.length > 0 &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        ) {
            enqueueDownload(
                download.url,
                download.userAgent,
                download.contentDisposition,
                download.mimeType
            );
        } else {
            Toast.makeText(this, "Storage permission is needed to download", Toast.LENGTH_SHORT).show();
        }
    }
}
