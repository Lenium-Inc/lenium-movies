package me.streamvy.movies;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts the native playback surface.
 *
 * The website cannot play these streams: the CDN requires the MovieBox player
 * page as its Referer and a Chrome network stack. The WebView activity in this
 * app has both, so the React bundle only has to hand it the catalogue ids.
 */
@CapacitorPlugin(name = "StreamVyPlayer")
public class StreamVyPlayerPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        String subjectId = call.getString("subjectId");
        String detailPath = call.getString("detailPath");

        if (subjectId == null || subjectId.trim().isEmpty()) {
            call.reject("subjectId is required");
            return;
        }
        if (detailPath == null || detailPath.trim().isEmpty()) {
            call.reject("detailPath is required");
            return;
        }

        int season = call.getInt("season", 1);
        int episode = call.getInt("episode", 1);
        String title = call.getString("title", "");

        Intent intent = new Intent(getActivity(), NativePlayerActivity.class);
        intent.putExtra(NativePlayerActivity.EXTRA_SUBJECT_ID, subjectId.trim());
        intent.putExtra(NativePlayerActivity.EXTRA_DETAIL_PATH, detailPath.trim());
        intent.putExtra(NativePlayerActivity.EXTRA_SEASON, season);
        intent.putExtra(NativePlayerActivity.EXTRA_EPISODE, episode);
        intent.putExtra(NativePlayerActivity.EXTRA_TITLE, title);
        getActivity().startActivity(intent);

        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }
}
