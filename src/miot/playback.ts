// Adapted from songloft-org/songloft-plugin-miot (Apache-2.0),
// commit bcf891ff346c2295614645594cd72d0c343eb246, src/mina/{constants,client}.ts.
// Only the Mina wire protocol is used; there is no plugin/runtime dependency.
const MUSIC_API_MODELS = new Set([
  "X08C",
  "X08E",
  "X8S",
  "X8F",
  "X4B",
  "LX05",
  "OH11",
  "OH2",
  "OH2P",
  "X6A",
  "LX04",
  "L05B",
  "L05C",
  "LX06",
  "L06A",
  "X08A",
  "X10A",
  "L15A",
  "L16A",
  "L17A",
]);
const MUSIC_AUDIO_ID = "1732418460076477549";

export function musicPlaybackRequest(hardware: string, url: string) {
  if (!MUSIC_API_MODELS.has(hardware.trim().toUpperCase()))
    return {
      method: "player_play_url",
      path: "mediaplayer",
      message: { url, type: 2, media: "app_ios" },
    };

  return {
    method: "player_play_music",
    path: "mediaplayer",
    message: {
      startaudioid: MUSIC_AUDIO_ID,
      music: JSON.stringify({
        payload: {
          audio_type: "",
          audio_items: [
            {
              item_id: {
                audio_id: MUSIC_AUDIO_ID,
                cp: {
                  album_id: "-1",
                  episode_index: 0,
                  id: "355454500",
                  name: "xiaowei",
                },
              },
              stream: { url },
            },
          ],
          list_params: {
            listId: "-1",
            loadmore_offset: 0,
            origin: "xiaowei",
            type: "MUSIC",
          },
        },
        play_behavior: "REPLACE_ALL",
      }),
    },
  };
}
