using UnityEngine;
//Importar a biblioteca para o Video Player
using UnityEngine.Video;
using UnityEngine.UI;

/* Tutorial de Unity
Playing Video In Unity - Introduction and Session Goals [1/8] Live 2017/7/12
https://www.youtube.com/watch?v=kwuHYwf7DvA */

public class PlayVideo : MonoBehaviour {

    private VideoPlayer videoPlayer;

    //Variaveis para as imagens dos botoes
    public Sprite playButtonSprite;
    public Sprite pauseButtonSprite;
    public Image imgButton;

    //Variveis para o texto que mostra os minutos do video
    public Text currentMinutes;
    public Text currentSeconds;
    public Text totalMinutes;
    public Text totalSeconds;

    //Variavel para a barra de progresso do video
    public PlayHeadMover playHeadMover;

    //Referencia para o componente Video Player
    private void Awake()
    {
        videoPlayer = GetComponent<VideoPlayer>();
    }

    private void Start()
    {
        videoPlayer.targetTexture.Release();
    }

    private void Update()
    {
        if (videoPlayer.isPlaying)
        {
            SetCurrentTime();
            playHeadMover.MovePlayHead(CalculatePlayedPfraction());
        }
    }

    //Metodo para executar e pausar o video
    public void PlayPause()
    {
        //Se o video estiver sendo executado, permitir que ele seja pausado
        if (videoPlayer.isPlaying)
        {
            videoPlayer.Pause();
            imgButton.sprite = playButtonSprite;
        }
        //Se o vídeo NAO estiver sendo executado, permitir que ele seja executado
        else
        {
            videoPlayer.Play();
            SetTotalTime();
            imgButton.sprite = pauseButtonSprite;
        }
    }

    //Metodo para mostrar os minutos e segundos atuais do video (ou seja, em que ponto o video está)
    private void SetCurrentTime()
    {
        string minutes = Mathf.Floor((int)videoPlayer.time / 60).ToString("00");
        string seconds = ((int)videoPlayer.time % 60).ToString("00");
        currentMinutes.text = minutes;
        currentSeconds.text = seconds;
    }

    //Metodo para mostrar o total de minutos e segundos do vídeo
    private void SetTotalTime()
    {
        string minutes = Mathf.Floor((int)videoPlayer.clip.length / 60).ToString("00");
        string seconds = ((int)videoPlayer.clip.length % 60).ToString("00");
        totalMinutes.text = minutes;
        totalSeconds.text = seconds;
    }

    //Metodo para calcular a movimentacao da barra de progresso conforme o tamanho do vídeo
    double CalculatePlayedPfraction()
    {
        double fraction = (double)videoPlayer.frame / (double)videoPlayer.frameCount;
        return fraction;
    }
}
