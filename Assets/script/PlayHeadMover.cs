using System.Collections;
using System.Collections.Generic;
using UnityEngine;

/* Tutorial de Unity
Playing Video In Unity - Introduction and Session Goals [1/8] Live 2017/7/12
https://www.youtube.com/watch?v=kwuHYwf7DvA */

public class PlayHeadMover : MonoBehaviour {

    public Transform startPoint;
    public Transform endPoint;

    public void MovePlayHead(double playedFraction)
    {
        transform.position = Vector3.Lerp(startPoint.position, endPoint.position, (float)playedFraction);
    }
}
